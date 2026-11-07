import { and, asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { buyable, buyableProducts } from '@/lib/catalog/buyable';
import type { Db } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

/** A product of `sellerId`, plain unless `changes` say otherwise. */
const product = (sellerId: string, sku: string, changes: Partial<typeof products.$inferInsert> = {}) => ({
  sellerId,
  sku,
  title: `Listing ${sku}`,
  category: 'spices' as const,
  priceCents: 450,
  stock: 10,
  ...changes,
});

/** Two sellers: Ravi with one product of each kind, and another seller with a plain product. */
async function shops(): Promise<{ db: Db; raviId: string }> {
  const db = await createTestDb();
  const [ravi, other] = await db
    .insert(sellers)
    .values([
      { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
      { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
    ])
    .returning({ id: sellers.id });
  await db.insert(products).values([
    product(ravi.id, 'TUR-100'),
    product(ravi.id, 'GIFT-SET', { stock: null }),
    product(ravi.id, 'SAF-1G', { flags: ['agent_instructions'] }),
    product(ravi.id, 'CUM-100', { stock: 0 }),
    product(ravi.id, 'BAS-1KG', { category: 'groceries', stock: 1 }),
    product(other.id, 'CABLE-1', { category: 'electronics' }),
  ]);
  return { db, raviId: ravi.id };
}

describe('what can be bought', () => {
  it("lists a seller's unflagged products in stock or with untracked stock, in SKU order", async () => {
    const { db, raviId } = await shops();

    const listed = await buyableProducts(db, raviId);

    expect(listed.map((row) => [row.sku, row.stock])).toEqual([
      ['BAS-1KG', 1],
      ['GIFT-SET', null],
      ['TUR-100', 10],
    ]);
    expect(listed.every((row) => row.sellerId === raviId && row.flags.length === 0)).toBe(true);
  });

  it('is a condition other product queries can add to their own', async () => {
    const { db } = await shops();

    const spices = await db
      .select({ sku: products.sku })
      .from(products)
      .where(and(buyable, eq(products.category, 'spices')))
      .orderBy(asc(products.sku));

    expect(spices.map((row) => row.sku)).toEqual(['GIFT-SET', 'TUR-100']);
  });
});
