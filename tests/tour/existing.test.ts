import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, sellerOrders } from '@/lib/db/schema';
import { pinsThatExist } from '@/lib/tour/existing';
import { NO_PINS } from '@/lib/tour/pins';
import { seededCart, seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// A pin whose record is gone, as after a demo reset, must read as no pin at all, so the tour shows
// that step's "not loaded" note instead of an empty panel or a page that cannot be found.

const GONE = '0a1b2c3d-0000-4000-8000-0000000000ff';
let db: Db;
let purchaseId: string;
let orderId: string;
let disputeId: string;

beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedPurchase(db, 'settled');
  purchaseId = seeded.purchaseId;
  const [order] = await db
    .insert(sellerOrders)
    .values({ sellerId: seeded.sellerId, status: 'accepted', cart: seededCart, receiptJws: 'not.a.jws' })
    .returning({ id: sellerOrders.id });
  orderId = order.id;
  const [dispute] = await db
    .insert(disputes)
    .values({ paypalDisputeId: 'PP-D-TOUR-1', purchaseId, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'UNDER_REVIEW', amountCents: 825 })
    .returning({ id: disputes.id });
  disputeId = dispute.id;
});

describe('pinsThatExist', () => {
  it('keeps every pin whose record is there', async () => {
    const pins = { allowed: purchaseId, held: purchaseId, blocked: purchaseId, order: orderId, dispute: disputeId };
    expect(await pinsThatExist(db, pins)).toEqual(pins);
  });

  it('empties each pin whose record is gone, and keeps the rest', async () => {
    expect(await pinsThatExist(db, { allowed: purchaseId, held: GONE, blocked: null, order: GONE, dispute: GONE })).toEqual({
      ...NO_PINS,
      allowed: purchaseId,
    });
  });

  it('does not take a purchase id for an order or a dispute', async () => {
    expect(await pinsThatExist(db, { ...NO_PINS, order: purchaseId, dispute: purchaseId })).toEqual(NO_PINS);
  });

  it('asks nothing of the database when nothing is pinned', async () => {
    expect(await pinsThatExist(db, NO_PINS)).toEqual(NO_PINS);
  });
});
