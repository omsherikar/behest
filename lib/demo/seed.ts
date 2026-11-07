import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { demoBuyerId } from '@/lib/app-deps';
import { parseCatalogCsv } from '@/lib/catalog/csv';
import { AGENT_INSTRUCTIONS_FLAG } from '@/lib/catalog/onboard';
import { screenText } from '@/lib/catalog/screen';
import type { Db } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import { type Category, isCategory } from '@/lib/domain/categories';
import { DEMO_SELLER_SLUG } from './personas';

// The demo's starting point: the buyer Priya, Ravi's Spice Co. with the listings in its catalog CSV,
// and Gadget Hub with one pair of earbuds. Nothing here calls a model or the market: listings are
// read from the CSV as the seller wrote them and screened by the fixed screen alone, so seeding is
// free and gives the same rows every time. There is no mandate, because the buyer signs one live.

/** Ravi's catalog, the same file the catalog tests read. */
const RAVI_CSV = path.join('tests', 'fixtures', 'catalog', 'ravi-spices.csv');

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
 * seller's payouts go to `payeeEmail`. Runs in one transaction. Throws, storing nothing, when the
 * payee email is missing or not an email, or when the demo catalog does not read cleanly.
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

/** The payee email trimmed, or a throw naming the setting when it is missing or not an email. */
function checkedPayeeEmail(payeeEmail: string): string {
  const email = payeeEmail.trim();
  if (!Email.safeParse(email).success) throw new Error(PAYEE_REQUIRED);
  return email;
}

/**
 * Ravi's Spice Co. with a listing for each row of its catalog CSV, as the seller wrote it. A listing
 * whose name and description the fixed screen finds aimed at AI agents carries the flag that keeps
 * agents from buying it.
 */
async function raviSpices(): Promise<DemoSeller> {
  const { rows, rejected } = parseCatalogCsv(await readFile(path.join(process.cwd(), RAVI_CSV), 'utf8'));
  if (rejected.length > 0) throw new Error(`${RAVI_CSV} line ${rejected[0].line}: ${rejected[0].reason}`);
  const listings = rows.map((row): Listing => {
    if (row.category === null || !isCategory(row.category)) {
      throw new Error(`${RAVI_CSV} line ${row.line}: ${JSON.stringify(row.category)} is not a category`);
    }
    return {
      sku: row.sku,
      title: row.name,
      description: row.description,
      category: row.category,
      priceCents: row.priceCents,
      stock: row.stock,
      flags: screenText(`${row.name}\n${row.description}`).suspicious ? [AGENT_INSTRUCTIONS_FLAG] : [],
    };
  });
  return { slug: DEMO_SELLER_SLUG, name: "Ravi's Spice Co.", listings };
}
