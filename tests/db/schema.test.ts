import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { buyers, mandates, products, purchases, sellerOrders, sellers, webhookEvents } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { createTestDb } from '@/tests/helpers/test-db';

// Postgres reports a unique constraint violation as SQLSTATE 23505; Drizzle keeps the driver error as `cause`.
const UNIQUE_VIOLATION = { cause: { code: '23505' } };

const HASH = 'a'.repeat(64);

const policy: MandatePolicy = {
  version: 1,
  currency: 'USD',
  budget: { amountCents: 6000, period: 'month' },
  perPurchaseMaxCents: 6000,
  askAboveCents: 2500,
  categories: { allow: ['groceries', 'spices'], deny: ['electronics'] },
  merchants: { allow: null, deny: [] },
  velocity: null,
  expiresAt: null,
};

const proposal: PurchaseProposal = {
  sellerSlug: 'ravi-spices',
  items: [
    { sku: 'TUR-100', quantity: 2 },
    { sku: 'CUM-100', quantity: 1 },
  ],
  rationale: 'The buyer asked for turmeric and cumin.',
};

const cart: Cart = {
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [
    { sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', unitPriceCents: 450, quantity: 2 },
    { sku: 'CUM-100', title: 'Cumin seeds 100g', category: 'spices', unitPriceCents: 375, quantity: 1 },
  ],
  totalCents: 1275,
};

async function addBuyer(db: Db) {
  const [buyer] = await db.insert(buyers).values({ name: 'Priya' }).returning();
  return buyer;
}

function mandateRow(buyerId: string, status: 'active' | 'revoked' | 'expired' = 'active') {
  return {
    buyerId,
    sourceText: '$60 a month on groceries and spices, ask me above $25, never electronics',
    policy,
    policyHash: HASH,
    readback: ['Your agent can spend up to $60.00 per calendar month (UTC).'],
    readbackHash: HASH,
    jws: 'header.payload.signature',
    status,
    confirmedAt: new Date('2026-11-06T10:00:00Z'),
  };
}

async function addSeller(db: Db, slug = 'ravi-spices') {
  const [seller] = await db
    .insert(sellers)
    .values({ slug, name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' })
    .returning();
  return seller;
}

/** A buyer with an active mandate, a seller, and the ids a purchase row needs. */
async function seedParties(db: Db) {
  const buyer = await addBuyer(db);
  const [mandate] = await db.insert(mandates).values(mandateRow(buyer.id)).returning();
  const seller = await addSeller(db);
  return { buyerId: buyer.id, mandateId: mandate.id, sellerId: seller.id };
}

function purchaseRow(parties: { buyerId: string; mandateId: string; sellerId: string }) {
  return {
    ...parties,
    request: 'Restock turmeric and cumin',
    proposal,
    cart,
    cartHash: HASH,
    totalCents: cart.totalCents,
    gateVerdict: 'ALLOW' as const,
    gateOutcomes: [{ rule: 'mandate_active', result: 'pass' as const, detail: 'The mandate is active.' }],
    rulesetVersion: 'gate-v1',
  };
}

function turmeric(sellerId: string) {
  return {
    sellerId,
    sku: 'TUR-100',
    title: 'Turmeric powder 100g',
    description: 'Single-origin Lakadong turmeric',
    category: 'spices' as const,
    priceCents: 450,
    stock: 40,
  };
}

it('applies migrations to an empty database', async () => {
  const db = await createTestDb();
  expect(await db.select().from(buyers)).toEqual([]);
});

it('round-trips a purchase with its jsonb cart', async () => {
  const db = await createTestDb();
  const parties = await seedParties(db);
  const [{ id }] = await db.insert(purchases).values(purchaseRow(parties)).returning({ id: purchases.id });

  const [row] = await db.select().from(purchases).where(eq(purchases.id, id));
  expect(row.cart).toEqual(cart);
  expect(row.proposal).toEqual(proposal);
  expect(row.status).toBe('proposed');
  expect(row.currency).toBe('USD');
});

it('rejects a duplicate seller slug', async () => {
  const db = await createTestDb();
  await addSeller(db, 'ravi-spices');
  await expect(addSeller(db, 'ravi-spices')).rejects.toMatchObject(UNIQUE_VIOLATION);
});

it('rejects a duplicate SKU for the same seller', async () => {
  const db = await createTestDb();
  const seller = await addSeller(db);
  await db.insert(products).values(turmeric(seller.id));
  await expect(db.insert(products).values(turmeric(seller.id)).execute()).rejects.toMatchObject(UNIQUE_VIOLATION);
});

it('allows the same SKU at two sellers', async () => {
  const db = await createTestDb();
  const ravi = await addSeller(db, 'ravi-spices');
  const other = await addSeller(db, 'spice-route');
  await db.insert(products).values([turmeric(ravi.id), turmeric(other.id)]);
  const rows = await db.select({ sellerId: products.sellerId, sku: products.sku }).from(products);
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.sku)).toEqual(['TUR-100', 'TUR-100']);
});

it('rejects a duplicate webhook event id', async () => {
  const db = await createTestDb();
  const event = {
    eventId: 'WH-58D329510W468432D-8HN650336L201105X',
    eventType: 'PAYMENT.CAPTURE.COMPLETED',
    payload: { id: 'WH-58D329510W468432D-8HN650336L201105X', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
  };
  await db.insert(webhookEvents).values(event);
  await expect(db.insert(webhookEvents).values(event).execute()).rejects.toMatchObject(UNIQUE_VIOLATION);
});

function sellerOrderRow(sellerId: string, status: 'accepted' | 'rejected') {
  return {
    sellerId,
    receiptId: '0b6a7c1e-3f52-4d8e-9a41-5c2e8f7d6b90',
    status,
    reason: status === 'rejected' ? 'cart_mismatch' : null,
    cart,
    receiptJws: 'header.payload.signature',
  };
}

it('never lets a rejected order occupy a receipt id', async () => {
  const db = await createTestDb();
  const seller = await addSeller(db);
  await db.insert(sellerOrders).values(sellerOrderRow(seller.id, 'rejected'));
  await db.insert(sellerOrders).values(sellerOrderRow(seller.id, 'rejected'));
  await db.insert(sellerOrders).values(sellerOrderRow(seller.id, 'accepted'));
  expect(await db.select().from(sellerOrders)).toHaveLength(3);
});

it('rejects a second accepted order for one receipt at one seller', async () => {
  const db = await createTestDb();
  const seller = await addSeller(db);
  await db.insert(sellerOrders).values(sellerOrderRow(seller.id, 'accepted'));
  await expect(db.insert(sellerOrders).values(sellerOrderRow(seller.id, 'accepted')).execute()).rejects.toMatchObject(
    UNIQUE_VIOLATION,
  );
});
