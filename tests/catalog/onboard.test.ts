import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogInputError } from '@/lib/catalog/build';
import { BENCHMARK_FAILURE_LOG, OnboardError, onboardSeller } from '@/lib/catalog/onboard';
import type { MarketProduct, searchMarket } from '@/lib/channel3/client';
import type { Db } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import raviReply from '@/tests/fixtures/llm/catalog_build/ravi-spices.json';
import refusalReply from '@/tests/fixtures/llm/catalog_build/refusal.json';
import { fakeClaude } from '@/tests/helpers/fake-claude';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-11-06T12:00:00Z');
const RAVI_CSV = readFileSync(join(import.meta.dirname, '../fixtures/catalog/ravi-spices.csv'), 'utf8');
const RAVI = { name: "Ravi's Spice Co.", slug: 'ravi-spices', payoutEmail: 'ravi@example.com', csvText: RAVI_CSV };

const marketProduct = (id: string, medianPriceCents: number): MarketProduct => ({
  id,
  title: id,
  brand: null,
  imageUrl: null,
  offers: [{ domain: 'spicebarn.com', priceCents: medianPriceCents, availability: 'InStock', url: 'https://spicebarn.com/p' }],
  medianPriceCents,
});

/**
 * A market where the turmeric has a close match and the gift box matches only a pallet priced far
 * above it, which enrichment rejects. Nothing else is found.
 */
const MARKET: Record<string, MarketProduct[]> = {
  'Lakadong Turmeric Powder, 100 g': [marketProduct('c3-turmeric', 480)],
  'Spice Gift Box': [marketProduct('c3-pallet', 100_000)],
};

const searchMarketFake = () => vi.fn<typeof searchMarket>(async (query) => MARKET[query] ?? []);

/** Onboarding dependencies whose model answers with `replies` in order. */
function depsFor(db: Db, replies: object[], search: typeof searchMarket = searchMarketFake()) {
  const fake = fakeClaude(replies);
  const claude = new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries: 0 });
  return { deps: { db, claude, now: () => NOW, env: { NODE_ENV: 'test' as const }, search }, requests: fake.requests };
}

async function productsOf(db: Db) {
  return db.select().from(products).orderBy(asc(products.sku));
}

async function onboardingError(promise: Promise<unknown>): Promise<OnboardError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OnboardError)) throw new Error(`expected an OnboardError, got ${String(error)}`);
  return error;
}

describe('onboarding a seller from a CSV', () => {
  it('creates the seller and its six products, one of them flagged', async () => {
    const db = await createTestDb();
    const { deps } = depsFor(db, [raviReply]);

    const result = await onboardSeller(deps, RAVI);

    expect(result).toEqual({ sellerId: expect.any(String), created: 6, flagged: 1, rejected: [] });
    expect(await db.select().from(sellers)).toEqual([
      expect.objectContaining({
        id: result.sellerId,
        slug: 'ravi-spices',
        name: "Ravi's Spice Co.",
        payoutEmail: 'ravi@example.com',
      }),
    ]);
    const rows = await productsOf(db);
    expect(rows.map((row) => row.sku)).toEqual(['BAS-1KG', 'CUM-100', 'GAR-200', 'GIFT-SET', 'SAF-1G', 'TUR-100']);
    expect(rows.every((row) => row.sellerId === result.sellerId)).toBe(true);
    expect(rows.find((row) => row.sku === 'TUR-100')).toMatchObject({
      title: 'Lakadong Turmeric Powder, 100 g',
      description: 'Single-origin turmeric powder from Lakadong.',
      category: 'spices',
      priceCents: 450,
      currency: 'USD',
      stock: 40,
    });
  });

  it('stores the flagged saffron with agent_instructions and leaves the other products unflagged', async () => {
    const db = await createTestDb();
    await onboardSeller(depsFor(db, [raviReply]).deps, RAVI);

    const flags = Object.fromEntries((await productsOf(db)).map((row) => [row.sku, row.flags]));
    expect(flags).toEqual({
      'BAS-1KG': [],
      'CUM-100': [],
      'GAR-200': [],
      'GIFT-SET': [],
      'SAF-1G': ['agent_instructions'],
      'TUR-100': [],
    });
  });

  it('stores an accepted benchmark and leaves listings without one at null', async () => {
    const db = await createTestDb();
    const search = searchMarketFake();
    await onboardSeller(depsFor(db, [raviReply], search).deps, RAVI);

    const benchmarks = Object.fromEntries(
      (await productsOf(db)).map((row) => [row.sku, [row.channel3Id, row.marketMedianCents]]),
    );
    expect(benchmarks).toEqual({
      'BAS-1KG': [null, null],
      'CUM-100': [null, null],
      'GAR-200': [null, null],
      // The pallet's median is over five times the gift box's price, so it is no benchmark.
      'GIFT-SET': [null, null],
      'SAF-1G': [null, null],
      'TUR-100': ['c3-turmeric', 480],
    });
    expect(search).toHaveBeenCalledTimes(6);
  });

  it('runs at most four market searches at a time', async () => {
    const db = await createTestDb();
    let running = 0;
    let most = 0;
    const search = vi.fn<typeof searchMarket>(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return [];
    });

    await onboardSeller(depsFor(db, [raviReply], search).deps, RAVI);

    expect(search).toHaveBeenCalledTimes(6);
    expect(most).toBe(4);
  });

  it('still onboards when the market search fails, with null benchmarks and one log line without the error text', async () => {
    const db = await createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const search = vi.fn<typeof searchMarket>(async () => {
      throw new Error('Channel3 401 on /v1/search: key sk-live-123 is revoked');
    });

    const result = await onboardSeller(depsFor(db, [raviReply], search).deps, RAVI);

    expect(result).toMatchObject({ created: 6, flagged: 1 });
    const rows = await productsOf(db);
    expect(rows.map((row) => [row.channel3Id, row.marketMedianCents])).toEqual(Array(6).fill([null, null]));
    expect(warn).toHaveBeenCalledOnce();
    const [line] = warn.mock.calls[0];
    expect(line).toMatch(new RegExp(`^${BENCHMARK_FAILURE_LOG}`));
    expect(line).not.toMatch(/401|sk-live|revoked/);
  });

  it('logs nothing when every search answers', async () => {
    const db = await createTestDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await onboardSeller(depsFor(db, [raviReply]).deps, RAVI);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the rows the CSV reader rejected, with their lines, and lists the rest', async () => {
    const db = await createTestDb();
    const csvText = `${RAVI_CSV}CHAI-50,Masala chai 50g,Loose leaf black tea,3.25,lots,beverages\nSALT-1,Rock salt,,0,5,spices\n`;

    const result = await onboardSeller(depsFor(db, [raviReply]).deps, { ...RAVI, csvText });

    expect(result).toMatchObject({ created: 6, flagged: 1 });
    expect(result.rejected).toEqual([
      { line: 8, reason: 'stock must be a whole number' },
      { line: 9, reason: 'price must be a positive amount' },
    ]);
  });
});

describe('what onboarding refuses', () => {
  it('refuses a slug another seller has, without a model call or any write', async () => {
    const db = await createTestDb();
    await onboardSeller(depsFor(db, [raviReply]).deps, RAVI);
    const before = await productsOf(db);
    const { deps, requests } = depsFor(db, []);

    const error = await onboardingError(onboardSeller(deps, { ...RAVI, name: 'Another Ravi' }));

    expect(error.code).toBe('slug_taken');
    expect(requests).toHaveLength(0);
    expect(await db.select().from(sellers)).toHaveLength(1);
    expect(await productsOf(db)).toEqual(before);
  });

  it('refuses a slug taken while the listings were being built, writing nothing', async () => {
    const db = await createTestDb();
    // Another onboarding finishes first, while this one is looking up benchmarks.
    const search = vi.fn<typeof searchMarket>(async () => {
      await db.insert(sellers).values({ slug: 'ravi-spices', name: 'First', payoutEmail: 'first@example.com' }).onConflictDoNothing();
      return [];
    });

    const error = await onboardingError(onboardSeller(depsFor(db, [raviReply], search).deps, RAVI));

    expect(error.code).toBe('slug_taken');
    expect(await db.select({ name: sellers.name }).from(sellers)).toEqual([{ name: 'First' }]);
    expect(await productsOf(db)).toEqual([]);
  });

  it('returns a failed build as build_failed with the model failure, and writes nothing', async () => {
    const db = await createTestDb();
    const search = searchMarketFake();

    const error = await onboardingError(onboardSeller(depsFor(db, [refusalReply], search).deps, RAVI));

    expect(error.code).toBe('build_failed');
    expect(error.failure).toMatchObject({ ok: false, error: 'refusal' });
    expect(search).not.toHaveBeenCalled();
    expect(await db.select().from(sellers)).toEqual([]);
    expect(await productsOf(db)).toEqual([]);
  });

  it('refuses a payout email that is not an email address before any model call', async () => {
    const db = await createTestDb();
    for (const payoutEmail of ['', 'ravi', 'ravi@', '@example.com', 'ravi @example.com', 'ravi@example']) {
      const { deps, requests } = depsFor(db, []);
      const error = await onboardingError(onboardSeller(deps, { ...RAVI, payoutEmail }));
      expect([payoutEmail, error.code]).toEqual([payoutEmail, 'invalid_payout_email']);
      expect(requests).toHaveLength(0);
    }
    expect(await db.select().from(sellers)).toEqual([]);
  });

  it('stores a payout email without the spaces around it', async () => {
    const db = await createTestDb();
    await onboardSeller(depsFor(db, [raviReply]).deps, { ...RAVI, payoutEmail: '  ravi@example.com ' });
    expect(await db.select({ payoutEmail: sellers.payoutEmail }).from(sellers)).toEqual([{ payoutEmail: 'ravi@example.com' }]);
  });

  it('refuses a slug that is not lower-case letters, digits and hyphens, and a blank name', async () => {
    const db = await createTestDb();
    for (const slug of ['', 'Ravi-Spices', 'ravi spices', 'ravi/spices', '-ravi', 'r'.repeat(64)]) {
      const error = await onboardingError(onboardSeller(depsFor(db, []).deps, { ...RAVI, slug }));
      expect([slug, error.code]).toEqual([slug, 'invalid_slug']);
    }
    const error = await onboardingError(onboardSeller(depsFor(db, []).deps, { ...RAVI, name: ' ​ ' }));
    expect(error.code).toBe('invalid_name');
    expect(await db.select().from(sellers)).toEqual([]);
  });

  it('refuses a catalog with nothing to list, returning the rejected rows', async () => {
    const db = await createTestDb();
    const csvText = 'sku,name,price\nTUR-100,Turmeric,free\n';

    const error = await onboardingError(onboardSeller(depsFor(db, []).deps, { ...RAVI, csvText }));

    expect(error.code).toBe('no_listings');
    expect(error.rejected).toEqual([{ line: 2, reason: 'price must be a positive amount' }]);
    expect(await db.select().from(sellers)).toEqual([]);
  });

  it('lets photos the builder cannot list fail as a CatalogInputError, writing nothing', async () => {
    const db = await createTestDb();
    const images = [{ mediaType: 'image/gif' as never, base64: 'R0lGODlh', priceCents: 500 }];

    await expect(onboardSeller(depsFor(db, []).deps, { ...RAVI, csvText: undefined, images })).rejects.toBeInstanceOf(
      CatalogInputError,
    );
    expect(await db.select().from(sellers).where(eq(sellers.slug, 'ravi-spices'))).toEqual([]);
  });
});
