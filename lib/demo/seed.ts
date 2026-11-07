import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ne } from 'drizzle-orm';
import { z } from 'zod';
import { demoBuyerId } from '@/lib/app-deps';
import { screenRow } from '@/lib/catalog/build';
import { parseCatalogCsv } from '@/lib/catalog/csv';
import { AGENT_INSTRUCTIONS_FLAG } from '@/lib/catalog/onboard';
import type { Db } from '@/lib/db/client';
import {
  disputes,
  jobs,
  mandates,
  payouts,
  products,
  purchaseEvents,
  purchases,
  receipts,
  refunds,
  sellerOrders,
  sellers,
  wallets,
} from '@/lib/db/schema';
import { type Category, isCategory } from '@/lib/domain/categories';
import { DEMO_SELLER_SLUG } from './personas';

// The demo's starting point: the buyer Priya, Ravi's Spice Co. with the listings in its catalog CSV,
// and Gadget Hub with one pair of earbuds. Nothing here calls a model or the market: listings are
// read from the CSV as the seller wrote them and screened by the fixed screen alone, so seeding is
// free and gives the same rows every time. There is no mandate, because the buyer signs one live.
// Resetting removes what a run of the demo left behind and seeds again, so the demo can be rerun.

/**
 * Ravi's catalog, relative to the project root, which is the working directory under `next start`, the
 * standalone server and the scripts. It ships with the app: next.config.ts traces it into the build
 * output for the reset route. The catalog tests read an identical copy under tests/fixtures.
 */
export const RAVI_CATALOG_CSV = path.join('lib', 'demo', 'ravi-spices.csv');

const PAYEE_REQUIRED = 'PAYEE_EMAIL must be set to the email of the sandbox business account that receives seller payouts';
const Email = z.email().max(254);

export type SeedDeps = {
  /** Where every seeded seller's payouts go: the one sandbox payee account. */
  payeeEmail: string;
};

export type SeedResult = { buyers: number; sellers: number; products: number; flagged: number };

type Listing = {
  sku: string;
  title: string;
  description: string;
  category: Category;
  priceCents: number;
  stock: number | null;
  flags: string[];
};

type DemoSeller = { slug: string; name: string; listings: Listing[] };

const GADGET_HUB: DemoSeller = {
  slug: 'gadget-hub',
  name: 'Gadget Hub',
  listings: [
    { sku: 'EAR-01', title: 'Wireless earbuds', description: '', category: 'electronics', priceCents: 2900, stock: null, flags: [] },
  ],
};

/**
 * Seeds the demo, or puts it back: the demo buyer, and each demo seller and its listings as listed
 * here, upserted by slug and by seller and SKU, so running it again leaves the same rows. Every
 * seller's payouts go to `payeeEmail`. A listing's market benchmark is not the seed's to set, so one
 * a listing already has is kept. Runs in one transaction. Throws, storing nothing, when the payee
 * email is missing or not an email, or when the demo catalog does not read cleanly.
 */
export async function seedDemo(db: Db, deps: SeedDeps): Promise<SeedResult> {
  const payoutEmail = checkedPayeeEmail(deps.payeeEmail);
  const demoSellers = [await raviSpices(), GADGET_HUB];

  return db.transaction(async (tx) => {
    await demoBuyerId(tx);
    for (const seller of demoSellers) {
      const fields = { name: seller.name, payoutEmail };
      const [{ id: sellerId }] = await tx
        .insert(sellers)
        .values({ slug: seller.slug, ...fields })
        .onConflictDoUpdate({ target: sellers.slug, set: fields })
        .returning({ id: sellers.id });
      for (const { sku, ...listing } of seller.listings) {
        await tx
          .insert(products)
          .values({ sellerId, sku, ...listing })
          .onConflictDoUpdate({ target: [products.sellerId, products.sku], set: listing });
      }
    }
    const listings = demoSellers.flatMap((seller) => seller.listings);
    return {
      buyers: 1,
      sellers: demoSellers.length,
      products: listings.length,
      flagged: listings.filter((listing) => listing.flags.length > 0).length,
    };
  });
}

export type ResetOptions = SeedDeps & {
  /** Also remove a linked wallet, which the buyer then has to link again at PayPal. */
  full?: boolean;
};

/** How many rows of each kind a reset removed. */
export type Removed = {
  purchases: number;
  purchaseEvents: number;
  receipts: number;
  sellerOrders: number;
  payouts: number;
  refunds: number;
  disputes: number;
  jobs: number;
  mandates: number;
  wallets: number;
};

export type ResetResult = { removed: Removed; seeded: SeedResult };

/**
 * Puts the demo back to where the seed leaves it: removes every purchase with its events, receipt,
 * payouts, refunds and disputes, every seller order, job and mandate, and every wallet that is not
 * linked, then seeds again, all in one transaction. A linked wallet is kept, because linking again
 * needs the buyer to approve at PayPal in a browser; `full` removes it too. Buyers, sellers and
 * products stay, and so do the model call log, which the daily spend cap sums, and the webhook
 * events, which keep each PayPal event from being processed twice. Throws, removing nothing, when
 * the payee email is missing or not an email.
 */
export async function resetDemo(db: Db, options: ResetOptions): Promise<ResetResult> {
  const payeeEmail = checkedPayeeEmail(options.payeeEmail);
  return db.transaction(async (tx) => {
    // Deleted one table at a time in the order written, each before the tables its rows refer to.
    const removed: Removed = {
      purchaseEvents: (await tx.delete(purchaseEvents).returning({ id: purchaseEvents.id })).length,
      receipts: (await tx.delete(receipts).returning({ id: receipts.id })).length,
      payouts: (await tx.delete(payouts).returning({ id: payouts.id })).length,
      refunds: (await tx.delete(refunds).returning({ id: refunds.id })).length,
      disputes: (await tx.delete(disputes).returning({ id: disputes.id })).length,
      sellerOrders: (await tx.delete(sellerOrders).returning({ id: sellerOrders.id })).length,
      jobs: (await tx.delete(jobs).returning({ id: jobs.id })).length,
      purchases: (await tx.delete(purchases).returning({ id: purchases.id })).length,
      mandates: (await tx.delete(mandates).returning({ id: mandates.id })).length,
      wallets: (
        await tx
          .delete(wallets)
          .where(options.full ? undefined : ne(wallets.status, 'linked'))
          .returning({ id: wallets.id })
      ).length,
    };
    return { removed, seeded: await seedDemo(tx, { payeeEmail }) };
  });
}

/** The payee email trimmed, or a throw naming the setting when it is missing or not an email. */
function checkedPayeeEmail(payeeEmail: string): string {
  const email = payeeEmail.trim();
  if (!Email.safeParse(email).success) throw new Error(PAYEE_REQUIRED);
  return email;
}

/**
 * Ravi's Spice Co. with a listing for each row of its catalog CSV, as the seller wrote it. A row the
 * catalog builder's own fixed screen finds aimed at AI agents carries the flag that keeps agents
 * from buying it, so the seed and an onboarding never disagree on what to flag.
 */
async function raviSpices(): Promise<DemoSeller> {
  const { rows, rejected } = parseCatalogCsv(await readFile(path.join(process.cwd(), RAVI_CATALOG_CSV), 'utf8'));
  if (rejected.length > 0) throw new Error(`${RAVI_CATALOG_CSV} line ${rejected[0].line}: ${rejected[0].reason}`);
  const listings = rows.map((row): Listing => {
    if (row.category === null || !isCategory(row.category)) {
      throw new Error(`${RAVI_CATALOG_CSV} line ${row.line}: ${JSON.stringify(row.category)} is not a category`);
    }
    return {
      sku: row.sku,
      title: row.name,
      description: row.description,
      category: row.category,
      priceCents: row.priceCents,
      stock: row.stock,
      flags: screenRow(row) ? [AGENT_INSTRUCTIONS_FLAG] : [],
    };
  });
  return { slug: DEMO_SELLER_SLUG, name: "Ravi's Spice Co.", listings };
}
