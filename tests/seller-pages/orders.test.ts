import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { payouts, purchases, receipts, sellerOrders, sellers } from '@/lib/db/schema';
import { payoutLabel, rejectionLabel, sellerOrderRows, sellerOrdersQuery } from '@/lib/seller-pages/orders';
import { seededCart, seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

const HASH = 'b'.repeat(64);
const PAID_RECEIPT = '0b6a3f5e-1d2c-4e8f-9a7b-3c5d6e7f8a90';
const UNPAID_RECEIPT = '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 12, minute));

let db: Db;
let sellerId: string;
let otherSellerId: string;

/**
 * The demo seller with five orders: an accepted one that has been paid out, a replay of its receipt,
 * an accepted one with no payout yet, one whose receipt had no readable id and one with a forged id.
 * Another seller accepted an order with the paid receipt's id too.
 */
beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedPurchase(db, 'accepted');
  sellerId = seeded.sellerId;
  const [paid] = await db.select().from(purchases).where(eq(purchases.id, seeded.purchaseId));
  const [unpaid] = await db
    .insert(purchases)
    .values({ ...paid, id: undefined, createdAt: undefined, updatedAt: undefined })
    .returning();
  const [other] = await db
    .insert(sellers)
    .values({ slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' })
    .returning();
  otherSellerId = other.id;

  await db.insert(receipts).values([
    { id: PAID_RECEIPT, purchaseId: paid.id, jws: 'paid.receipt.jws', payloadHash: HASH, keyId: 'key-1' },
    { id: UNPAID_RECEIPT, purchaseId: unpaid.id, jws: 'unpaid.receipt.jws', payloadHash: HASH, keyId: 'key-1' },
  ]);
  await db.insert(payouts).values({
    purchaseId: paid.id,
    sellerId,
    amountCents: seededCart.totalCents,
    senderBatchId: `${paid.id}:payout`,
    status: 'SUCCESS',
  });

  const order = { cart: seededCart, receiptJws: 'presented.receipt.jws' };
  await db.insert(sellerOrders).values([
    { ...order, sellerId, receiptId: PAID_RECEIPT, status: 'accepted', createdAt: at(1) },
    { ...order, sellerId, receiptId: PAID_RECEIPT, status: 'rejected', reason: 'replayed', createdAt: at(2) },
    { ...order, sellerId, receiptId: UNPAID_RECEIPT, status: 'accepted', createdAt: at(3) },
    { ...order, sellerId, receiptId: null, status: 'rejected', reason: 'malformed', createdAt: at(4) },
    { ...order, sellerId, receiptId: 'not-a-receipt-id', status: 'rejected', reason: 'bad_signature', createdAt: at(5) },
    { ...order, sellerId: other.id, receiptId: PAID_RECEIPT, status: 'accepted', createdAt: at(6) },
  ]);
});

describe('sellerOrderRows', () => {
  it("lists the seller's orders newest first with the receipt check, cart total and payout", async () => {
    const rows = await sellerOrderRows(db, sellerId);
    const withoutIds = rows.map(({ id, ...row }) => {
      expect(id).toEqual(expect.any(String));
      return row;
    });
    expect(withoutIds).toEqual([
      {
        createdAt: '2026-11-06T12:05:00.000Z',
        receiptId: 'not-a-receipt-id',
        status: 'rejected',
        reason: 'The signature did not verify',
        totalCents: 1875,
        payout: null,
      },
      {
        createdAt: '2026-11-06T12:04:00.000Z',
        receiptId: null,
        status: 'rejected',
        reason: 'The receipt could not be read',
        totalCents: 1875,
        payout: null,
      },
      {
        createdAt: '2026-11-06T12:03:00.000Z',
        receiptId: UNPAID_RECEIPT,
        status: 'accepted',
        reason: null,
        totalCents: 1875,
        payout: 'Not sent yet',
      },
      {
        createdAt: '2026-11-06T12:02:00.000Z',
        receiptId: PAID_RECEIPT,
        status: 'rejected',
        reason: 'The receipt was already used',
        totalCents: 1875,
        payout: null,
      },
      {
        createdAt: '2026-11-06T12:01:00.000Z',
        receiptId: PAID_RECEIPT,
        status: 'accepted',
        reason: null,
        totalCents: 1875,
        payout: 'Paid',
      },
    ]);
  });

  it("never shows another seller's payout, even for an order carrying its receipt id", async () => {
    const rows = await sellerOrderRows(db, otherSellerId);
    expect(rows).toEqual([expect.objectContaining({ receiptId: PAID_RECEIPT, status: 'accepted', payout: 'Not sent yet' })]);
  });

  it('carries nothing about the buyer: no request, reasons, intent or mandate', async () => {
    const rows = await sellerOrderRows(db, sellerId);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'payout', 'reason', 'receiptId', 'status', 'totalCents']);
    }
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Restock turmeric and cumin');
    expect(text).not.toContain('$60 a month');
  });
});

describe('sellerOrdersQuery', () => {
  it('selects only seller order columns and the payout status, and reads no buyer table', () => {
    const { sql } = sellerOrdersQuery(db, sellerId).toSQL();
    const selected = sql.slice(0, sql.indexOf(' from '));
    const columns = [...selected.matchAll(/"(\w+)"\."(\w+)"/g)].map(([, table, column]) => `${table}.${column}`);
    expect(columns.sort()).toEqual([
      'payouts.status',
      'seller_orders.cart',
      'seller_orders.created_at',
      'seller_orders.id',
      'seller_orders.reason',
      'seller_orders.receipt_id',
      'seller_orders.status',
    ]);
    expect(sql).not.toMatch(/"(purchases|purchase_events|mandates|buyers|wallets)"/);
  });
});

describe('labels', () => {
  it('words every receipt rejection, and an unknown one from its code', () => {
    expect(rejectionLabel('bad_signature')).toBe('The signature did not verify');
    expect(rejectionLabel('malformed')).toBe('The receipt could not be read');
    expect(rejectionLabel('expired')).toBe('The receipt had expired');
    expect(rejectionLabel('wrong_seller')).toBe('The receipt was for another seller');
    expect(rejectionLabel('cart_mismatch')).toBe('The cart did not match the receipt');
    expect(rejectionLabel('amount_mismatch')).toBe('The amount did not match the receipt');
    expect(rejectionLabel('replayed')).toBe('The receipt was already used');
    expect(rejectionLabel('new_check_failed')).toBe('New check failed');
  });

  it("words PayPal's payout statuses", () => {
    expect(payoutLabel('SUCCESS')).toBe('Paid');
    expect(payoutLabel('PENDING')).toBe('Pending');
    expect(payoutLabel('UNCLAIMED')).toBe('Unclaimed');
    expect(payoutLabel('ONHOLD')).toBe('On hold');
    expect(payoutLabel('CANCELED')).toBe('Cancelled');
    expect(payoutLabel('RETURNED')).toBe('Returned');
    expect(payoutLabel('SOME_NEW_STATUS')).toBe('Some new status');
  });
});
