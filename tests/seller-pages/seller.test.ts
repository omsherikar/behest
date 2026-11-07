import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { products, sellerOrders, sellers } from '@/lib/db/schema';
import { findSeller, sellerSummary } from '@/lib/seller-pages/seller';
import { seededCart } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

let db: Db;
let raviId: string;

beforeAll(async () => {
  db = await createTestDb();
  const [ravi, other] = await db
    .insert(sellers)
    .values([
      { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
      { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
    ])
    .returning();
  raviId = ravi.id;
  await db.insert(products).values([
    { sellerId: ravi.id, sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', priceCents: 450 },
    {
      sellerId: ravi.id,
      sku: 'SAF-1G',
      title: 'Kashmiri saffron 1g',
      category: 'spices',
      priceCents: 1200,
      flags: ['agent_instructions'],
    },
    {
      sellerId: other.id,
      sku: 'EAR-01',
      title: 'Wireless earbuds',
      category: 'electronics',
      priceCents: 2900,
      flags: ['agent_instructions'],
    },
  ]);
  const order = { cart: seededCart, receiptJws: 'presented.receipt.jws' };
  await db.insert(sellerOrders).values([
    { ...order, sellerId: ravi.id, receiptId: 'r-1', status: 'accepted' },
    { ...order, sellerId: ravi.id, receiptId: 'r-1', status: 'rejected', reason: 'replayed' },
    { ...order, sellerId: ravi.id, receiptId: null, status: 'rejected', reason: 'malformed' },
    { ...order, sellerId: other.id, receiptId: 'r-2', status: 'accepted' },
  ]);
});

describe('findSeller', () => {
  it('finds a seller by slug, or null', async () => {
    expect(await findSeller(db, 'ravi-spices')).toEqual({ id: raviId, slug: 'ravi-spices', name: "Ravi's Spice Co." });
    expect(await findSeller(db, 'nobody')).toBeNull();
  });
});

describe('sellerSummary', () => {
  it("counts the seller's own listings and orders, and names the listings hidden from agents", async () => {
    expect(await sellerSummary(db, 'ravi-spices')).toEqual({
      id: raviId,
      slug: 'ravi-spices',
      name: "Ravi's Spice Co.",
      payoutEmail: 'ravi@example.com',
      listings: 2,
      hidden: [{ sku: 'SAF-1G', title: 'Kashmiri saffron 1g', reason: 'Its text speaks to AI agents' }],
      orders: { accepted: 1, rejected: 2 },
    });
  });

  it('is null for a slug no seller has', async () => {
    expect(await sellerSummary(db, 'nobody')).toBeNull();
  });

  it('counts nothing for a seller with no listings or orders', async () => {
    await db.insert(sellers).values({ slug: 'new-shop', name: 'New Shop', payoutEmail: 'new@example.com' });
    expect(await sellerSummary(db, 'new-shop')).toMatchObject({ listings: 0, hidden: [], orders: { accepted: 0, rejected: 0 } });
  });
});
