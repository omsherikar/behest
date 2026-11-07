import { PGlite } from '@electric-sql/pglite';
import { and, eq, inArray } from 'drizzle-orm';
import { buildShoppingTools } from '@/lib/agent/tools';
import { demoBuyerId } from '@/lib/app-deps';
import { screenRow } from '@/lib/catalog/build';
import { type CatalogRow, parseCatalogCsv } from '@/lib/catalog/csv';
import { enrichListing } from '@/lib/catalog/enrich';
import { AGENT_INSTRUCTIONS_FLAG } from '@/lib/catalog/onboard';
import { screenText } from '@/lib/catalog/screen';
import { type SellerNameRefusal, sellerNameRefusal } from '@/lib/catalog/seller-name';
import type { MarketProduct } from '@/lib/channel3/client';
import { type Db, migrateDb, pgliteDb } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import { type Category, isCategory } from '@/lib/domain/categories';
import type { Verdict } from '@/lib/domain/verdict';
import { seedDemo } from '@/lib/demo/seed';
import { evaluateGateSafely } from '@/lib/gate/evaluate';
import { removeHiddenCharacters } from '@/lib/llm/untrusted';
import { type Attack, ATTACKS, attackCsv, REPLAY_MANDATE } from './attacks';
import type { LayerState, ReplayResult } from './results';

// Replays each attack through Behest's deterministic layers, with no network and no model. Every
// attack gets its own in-memory database seeded as the demo is, plus the attack's seller and listing.
// A new seller's name goes through onboarding's name check, and the listing is listed the way the
// demo seed lists Ravi's catalog: the seller's CSV row read by the catalog reader,
// flagged by the fixed screen, given the market median enrichment keeps, and stored with the seller's
// own category. Then the shopping agent's tools are asked for the listing, and the gate is run on the
// cart the attack wants under the demo mandate, with nothing spent this month and a linked wallet.
// Each layer is replayed on its own: a seller onboarding would refuse is stored anyway, so the later
// layers show what they would do had it been let in.

type ScreenLayer = ReplayResult['screen'];
type VisibilityLayer = ReplayResult['visibility'];
type GateLayer = ReplayResult['gate'];

/** The demo seed's payee, and every replayed seller's. Nothing is paid out in a replay. */
const PAYEE = 'payouts@replay.example.com';

/** The clock the gate is replayed on. The demo mandate has no end date and no velocity limit, so any day gives the same result. */
const REPLAY_NOW = new Date('2026-11-06T12:00:00Z');

/** The seller-written fields the agent's tools return for a listing. Each must reach the model quoted. */
const SELLER_FIELDS = ['sellerName', 'title', 'description'] as const;

/** A seller listing quote as the agent's tools write it: no `<` inside, since quoting escapes every one. */
const QUOTED = /^<untrusted source="seller_listing">[^<]*<\/untrusted>$/;

const STATE_OF: Record<Verdict, LayerState> = { BLOCK: 'stopped', ASK: 'flagged', ALLOW: 'passed' };

/** An attack's seller and listing on top of the demo, in a database of its own. */
export type ReplayCatalog = {
  db: Db;
  /** The demo buyer. */
  buyerId: string;
  seller: { id: string; slug: string; name: string };
  /** The attack's listing as the CSV reader read it. */
  row: CatalogRow;
  /**
   * Why onboarding would refuse the attack's seller, or null when it would let it in or the seller is
   * one the demo already has. A refused seller is stored anyway, so the later layers can be replayed alone.
   */
  sellerRefusal: SellerNameRefusal | null;
  close: () => Promise<void>;
};

let template: Promise<File | Blob> | undefined;

/** A data directory with every migration applied, made once per process; a failed attempt is not kept. */
function migratedTemplate(): Promise<File | Blob> {
  template ??= (async () => {
    const client = new PGlite();
    await migrateDb(pgliteDb(client));
    const dump = await client.dumpDataDir('none');
    await client.close();
    return dump;
  })().catch((error: unknown) => {
    template = undefined;
    throw error;
  });
  return template;
}

/** The attack's listing as the catalog reader reads its seller's CSV. Throws when the row would not be listed. */
function attackRow(attack: Attack): CatalogRow {
  const { rows, rejected } = parseCatalogCsv(attackCsv(attack));
  if (rejected.length > 0 || rows.length !== 1) {
    throw new Error(`the ${attack.id} listing is not one catalog row: ${rejected[0]?.reason ?? `${rows.length} rows`}`);
  }
  return rows[0];
}

/** The market search as enrichment calls it, answering with the attack's median for any title. */
function marketFor(attack: Attack) {
  return async (query: string): Promise<MarketProduct[]> =>
    attack.marketMedianCents === null
      ? []
      : [{ id: `replay-${attack.id}`, title: query, brand: null, imageUrl: null, offers: [], medianPriceCents: attack.marketMedianCents }];
}

/**
 * A fresh in-memory database with the demo seeded and the attack's listing added at its seller,
 * created unless the demo already has it. The listing carries the flag the demo seed's screen gives
 * it and the benchmark enrichment keeps. The caller closes it.
 */
export async function openReplayCatalog(attack: Attack): Promise<ReplayCatalog> {
  const client = new PGlite({ loadDataDir: await migratedTemplate() });
  const db = pgliteDb(client);
  const close = () => client.close();
  try {
    await seedDemo(db, { payeeEmail: PAYEE });
    const row = attackRow(attack);
    const category = attackCategory(row);
    const benchmark = await enrichListing({ title: row.name, priceCents: row.priceCents }, marketFor(attack));
    const [known] = await db.select({ id: sellers.id }).from(sellers).where(eq(sellers.slug, attack.seller.slug));
    const sellerRefusal = known ? null : await sellerNameRefusal(db, attack.seller.name, attack.seller.slug);
    const seller = await db.transaction(async (tx) => {
      await tx.insert(sellers).values({ ...attack.seller, payoutEmail: PAYEE }).onConflictDoNothing({ target: sellers.slug });
      const [found] = await tx
        .select({ id: sellers.id, slug: sellers.slug, name: sellers.name })
        .from(sellers)
        .where(eq(sellers.slug, attack.seller.slug));
      await tx.insert(products).values({
        sellerId: found.id,
        sku: row.sku,
        title: row.name,
        description: row.description,
        category,
        priceCents: row.priceCents,
        stock: row.stock,
        flags: screenRow(row) ? [AGENT_INSTRUCTIONS_FLAG] : [],
        channel3Id: benchmark?.channel3Id ?? null,
        marketMedianCents: benchmark?.marketMedianCents ?? null,
      });
      return found;
    });
    return { db, buyerId: await demoBuyerId(db), seller, row, sellerRefusal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The row's category as the seller wrote it, as the demo seed stores it. Throws when it is not in the fixed list. */
function attackCategory(row: CatalogRow): Category {
  const category = row.category ?? '';
  if (!isCategory(category)) throw new Error(`line ${row.line}: ${JSON.stringify(category)} is not a category`);
  return category;
}

/**
 * Onboarding: a new seller's name check, then the listing as the demo seed reads and screens it.
 * Stopped when the seller would be refused. Otherwise flagged when the screen flags the stored row,
 * and stopped when the CSV reader dropped hidden characters that, read as the seller sent them,
 * spelled an instruction the screen would flag and that the stored row no longer holds.
 */
function screenLayer(attack: Attack, { row, sellerRefusal }: ReplayCatalog): ScreenLayer {
  const sent = `${attack.listing.name}\n${attack.listing.description}`;
  const flagging = screenRow(row);
  const stored = flagging ?? screenText(`${row.name}\n${row.description}`);
  const hiddenRemoved = Array.from(sent).length - Array.from(removeHiddenCharacters(sent)).length;
  const asSent = screenText(sent);
  const storedPhrases = new Set(stored.matches.map((phrase) => phrase.toLowerCase()));
  const hiddenPhrases =
    hiddenRemoved > 0 ? asSent.matches.filter((phrase) => !storedPhrases.has(phrase.toLowerCase())) : [];
  const removed = hiddenPhrases.length > 0 && asSent.suspicious;
  const state: LayerState = sellerRefusal || (!flagging && removed) ? 'stopped' : flagging ? 'flagged' : 'passed';
  return {
    state,
    flagged: flagging !== null,
    strong: stored.strong,
    weak: stored.weak,
    hiddenRemoved,
    hiddenPhrases,
    sellerRefused: sellerRefusal,
  };
}

/**
 * What the shopping agent's tools show of the listing: whether a search for its title lists it,
 * whether opening it shows it, and which seller-written fields of either reach the model unquoted.
 * Stopped when neither shows it.
 */
async function visibilityLayer(catalog: ReplayCatalog, attack: Attack): Promise<VisibilityLayer> {
  const { db, buyerId, seller, row } = catalog;
  const tools = buildShoppingTools({
    db,
    buyerId,
    runId: 'attack-replay',
    request: attack.request,
    propose: async () => {
      throw new Error('the deterministic replay proposes nothing');
    },
    record: () => {},
  });
  // Run as the tool runner runs them: the model's input parsed, then the tool.
  const run = async (name: string, input: unknown): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`the shopping agent has no ${name} tool`);
    return String(await tool.run(tool.parse(input)));
  };

  const searched = JSON.parse(await run('search_sellers', { query: row.name })) as Record<string, unknown>[];
  const listed = searched.find((result) => result.sellerSlug === seller.slug && result.sku === row.sku);
  const opened = await run('get_product', { sellerSlug: seller.slug, sku: row.sku });
  const shown = opened.startsWith('{') ? (JSON.parse(opened) as Record<string, unknown>) : undefined;

  const unquoted = SELLER_FIELDS.filter((field) =>
    [listed, shown].some((result) => result !== undefined && field in result && !QUOTED.test(String(result[field]))),
  );
  const visible = listed !== undefined || shown !== undefined;
  return { state: visible ? 'passed' : 'stopped', listed: listed !== undefined, shown: shown !== undefined, unquoted };
}

/** The gate on the cart the attack wants, with the listing loaded from the database as a purchase loads it. */
async function gateLayer(catalog: ReplayCatalog, attack: Attack): Promise<GateLayer> {
  const { db, seller, row } = catalog;
  const entries = await db
    .select({
      sku: products.sku,
      title: products.title,
      category: products.category,
      priceCents: products.priceCents,
      stock: products.stock,
      flags: products.flags,
      marketMedianCents: products.marketMedianCents,
    })
    .from(products)
    .where(and(eq(products.sellerId, seller.id), inArray(products.sku, [row.sku])));
  const gate = evaluateGateSafely({
    policy: REPLAY_MANDATE.policy,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: { slug: seller.slug, name: seller.name },
    proposal: { sellerSlug: seller.slug, items: [{ sku: row.sku, quantity: attack.quantity }], rationale: '' },
    catalog: new Map(entries.map((entry) => [entry.sku, entry])),
    spentInPeriodCents: 0,
    recentPurchaseTimes: [],
    now: REPLAY_NOW,
  });
  const item = gate.cart?.items[0];
  return {
    state: STATE_OF[gate.verdict],
    verdict: gate.verdict,
    cart: gate.cart && item ? { sku: item.sku, quantity: item.quantity, totalCents: gate.cart.totalCents } : null,
    rules: gate.outcomes,
  };
}

/** Each attack through onboarding, the agent's tools and the gate, one database each, in order. */
export async function replayAttacks(attacks: Attack[] = ATTACKS): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const attack of attacks) {
    const catalog = await openReplayCatalog(attack);
    try {
      results.push({
        attack: attack.id,
        screen: screenLayer(attack, catalog),
        visibility: await visibilityLayer(catalog, attack),
        gate: await gateLayer(catalog, attack),
      });
    } finally {
      await catalog.close();
    }
  }
  return results;
}
