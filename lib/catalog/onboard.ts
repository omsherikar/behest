import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { searchMarket } from '@/lib/channel3/client';
import { products, sellers } from '@/lib/db/schema';
import { merchantSlug } from '@/lib/domain/policy';
import type { LlmDeps, LlmResult } from '@/lib/llm/client';
import { buildListings, type ListingDraft, type ListingPhoto } from './build';
import { type CatalogRejection, oneLine, parseCatalogCsv } from './csv';
import { enrichListing } from './enrich';

// Onboarding a seller: their catalog read from a CSV and photos, drafted and screened by the catalog
// builder, benchmarked against market prices, then stored with the seller in one transaction. The
// model and market calls all finish before anything is written, so a failed onboarding leaves no
// seller and no products behind.

/** The flag a product carries when its listing was screened as text aimed at AI agents. */
export const AGENT_INSTRUCTIONS_FLAG = 'agent_instructions';

/** How a market search failure is logged: once per onboarding, with counts but never the error's text. */
export const BENCHMARK_FAILURE_LOG = 'Seller onboarding: market search failed';

/** Market searches running at once. */
const SEARCH_CONCURRENCY = 4;
const NAME_MAX = 120;
const EMAIL_MAX = 254;
const Email = z.email().max(EMAIL_MAX);

export type OnboardErrorCode =
  | 'invalid_name'
  | 'invalid_slug'
  | 'invalid_payout_email'
  | 'slug_taken'
  | 'no_listings'
  | 'build_failed';

/** What each refusal tells the seller. */
const MESSAGES: Record<OnboardErrorCode, string> = {
  invalid_name: 'Give your shop a name.',
  invalid_slug:
    'The shop address must be lower-case letters, digits and hyphens, starting with a letter or digit, at most 63 characters.',
  invalid_payout_email: 'The payout email must be an email address.',
  slug_taken: 'Another seller already uses this shop address.',
  no_listings: 'The catalog has no row or photo that can be listed.',
  build_failed: 'Behest could not draft listings from this catalog.',
};

type BuildFailure = Extract<LlmResult<never>, { ok: false }>;

/** Why a seller was not onboarded. Nothing is stored when one is thrown. */
export class OnboardError extends Error {
  readonly code: OnboardErrorCode;
  /** For `build_failed`: the model call's failure. */
  readonly failure?: BuildFailure;
  /** For `no_listings`: the CSV rows the reader rejected, with their lines. */
  readonly rejected: CatalogRejection[];

  constructor(code: OnboardErrorCode, details: { failure?: BuildFailure; rejected?: CatalogRejection[] } = {}) {
    super(MESSAGES[code]);
    this.name = 'OnboardError';
    this.code = code;
    this.failure = details.failure;
    this.rejected = details.rejected ?? [];
  }
}

export type OnboardDeps = LlmDeps & { search?: typeof searchMarket };

export type OnboardInput = {
  name: string;
  slug: string;
  payoutEmail: string;
  csvText?: string;
  images?: ListingPhoto[];
};

export type OnboardResult = { sellerId: string; created: number; flagged: number; rejected: CatalogRejection[] };

type Benchmark = Awaited<ReturnType<typeof enrichListing>>;

/**
 * Creates a new seller with a product for each listing drafted from its CSV rows and photos. A
 * listing screened as text aimed at AI agents is stored with the `agent_instructions` flag and
 * counted in `flagged`. Each listing gets a market benchmark when enrichment accepts one; a search
 * that fails leaves that listing without one. CSV rows the reader rejected come back in `rejected`.
 *
 * Throws an OnboardError, storing nothing, for a blank name, a malformed slug or payout email, a
 * slug another seller has (checked before any model call and again on insert), a catalog with
 * nothing to list, or a failed build. Photos the builder cannot list throw its CatalogInputError.
 */
export async function onboardSeller(deps: OnboardDeps, i: OnboardInput): Promise<OnboardResult> {
  const name = oneLine(i.name, NAME_MAX);
  if (name === '') throw new OnboardError('invalid_name');
  // The shape a mandate's merchant list takes, so a buyer can allow or deny any seller by name.
  if (!merchantSlug.safeParse(i.slug).success) throw new OnboardError('invalid_slug');
  const payoutEmail = i.payoutEmail.trim();
  if (!Email.safeParse(payoutEmail).success) throw new OnboardError('invalid_payout_email');
  if (await slugTaken(deps, i.slug)) throw new OnboardError('slug_taken');

  const { rows, rejected } = i.csvText === undefined ? { rows: [], rejected: [] } : parseCatalogCsv(i.csvText);
  const images = i.images ?? [];
  if (rows.length === 0 && images.length === 0) throw new OnboardError('no_listings', { rejected });

  const built = await buildListings(deps, { rows, images });
  if (!built.ok) throw new OnboardError('build_failed', { failure: built });
  const drafts = built.value;
  const benchmarks = await benchmarksFor(drafts, deps.search ?? searchMarket);

  const sellerId = await deps.db.transaction(async (tx) => {
    // Another onboarding may have taken the slug while this one was building.
    const [seller] = await tx
      .insert(sellers)
      .values({ slug: i.slug, name, payoutEmail })
      .onConflictDoNothing({ target: sellers.slug })
      .returning({ id: sellers.id });
    if (!seller) throw new OnboardError('slug_taken');
    await tx.insert(products).values(
      drafts.map((draft, index) => ({
        sellerId: seller.id,
        sku: draft.sku,
        title: draft.title,
        description: draft.description,
        category: draft.category,
        priceCents: draft.priceCents,
        stock: draft.stock,
        flags: draft.screening.suspicious ? [AGENT_INSTRUCTIONS_FLAG] : [],
        channel3Id: benchmarks[index]?.channel3Id ?? null,
        marketMedianCents: benchmarks[index]?.marketMedianCents ?? null,
      })),
    );
    return seller.id;
  });

  return {
    sellerId,
    created: drafts.length,
    flagged: drafts.filter((draft) => draft.screening.suspicious).length,
    rejected,
  };
}

async function slugTaken({ db }: OnboardDeps, slug: string): Promise<boolean> {
  const [seller] = await db.select({ id: sellers.id }).from(sellers).where(eq(sellers.slug, slug)).limit(1);
  return seller !== undefined;
}

/**
 * Each draft's benchmark, in draft order, searching at most `SEARCH_CONCURRENCY` at a time. A failed
 * search is no benchmark. The error's text is not logged: it can quote the market API's reply.
 */
async function benchmarksFor(drafts: ListingDraft[], search: typeof searchMarket): Promise<Benchmark[]> {
  let failures = 0;
  const benchmarks = await mapLimited(drafts, SEARCH_CONCURRENCY, async (draft) => {
    try {
      return await enrichListing(draft, search);
    } catch {
      failures += 1;
      return null;
    }
  });
  if (failures > 0) {
    console.warn(`${BENCHMARK_FAILURE_LOG} for ${failures} of ${drafts.length} listings, so they have no benchmark`);
  }
  return benchmarks;
}

/** `fn` applied to each item with at most `limit` calls running at once, results in item order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
