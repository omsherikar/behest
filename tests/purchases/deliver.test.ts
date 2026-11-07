import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { jobs, payouts, purchases, refunds } from '@/lib/db/schema';
import { deliverToSeller, retryLostRefund } from '@/lib/purchases/deliver';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { issueReceipt } from '@/lib/purchases/receipt';
import { setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf, SEEDED_SELLER, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

/** A captured purchase with its receipt issued, ready to hand to the seller. */
async function setUpReceipted() {
  const s = await setUpCaptured();
  const receipt = await issueReceipt(s.deps, s.purchaseId);
  return { ...s, ...receipt };
}

/** The purchase's events after its receipt, the point delivery starts from. */
async function eventsAfterReceipt(db: PurchaseDeps['db'], purchaseId: string) {
  const events = await eventsOf(db, purchaseId);
  return events.slice(events.findIndex((e) => e.kind === 'receipt') + 1);
}

describe('deliverToSeller', () => {
  it('hands the seller the cart and receipt, and pays the seller once it accepts', async () => {
    const { db, deps, paypal, seller, purchaseId, receiptId, jws } = await setUpReceipted();

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toEqual([{ sellerSlug: SEEDED_SELLER.slug, cart: seededCart, receiptJws: jws }]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(paypal.payouts).toEqual([expect.objectContaining({ senderBatchId: `${purchaseId}:payout`, amountCents: seededCart.totalCents })]);
    // payoutSeller queues the poll of its payout; delivery queues nothing of its own.
    expect(await db.select({ kind: jobs.kind }).from(jobs)).toEqual([{ kind: 'payout_poll' }]);
    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_accepted', data: { receiptId } },
      { kind: 'status', data: { from: 'captured', to: 'accepted' } },
    ]);
  });

  it('refunds the captured amount, once, when the seller rejects the order', async () => {
    const { db, deps, paypal, seller, purchaseId, captureId } = await setUpReceipted();
    seller.mode = 'reject';

    await deliverToSeller(deps, purchaseId);

    const note = `The seller did not accept Behest order ${purchaseId}.`;
    expect(paypal.callsTo('refundCapture')).toEqual([
      [{ captureId, amountCents: seededCart.totalCents, note, requestId: `${purchaseId}:refund` }],
    ]);
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await db.select().from(refunds)).toEqual([
      expect.objectContaining({
        purchaseId,
        amountCents: seededCart.totalCents,
        currency: 'USD',
        paypalRefundId: paypal.refunds[0].refundId,
        status: 'COMPLETED',
        reason: note,
      }),
    ]);
    expect(paypal.payouts).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund', data: { refundId: paypal.refunds[0].refundId, status: 'COMPLETED', amountCents: seededCart.totalCents } },
      { kind: 'status', data: { from: 'captured', to: 'refunded' } },
    ]);
  });

  it('asks again with the same request id when a refund answer is lost, refunding once', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    paypal.failNext('refundCapture', 'lost_response');

    await deliverToSeller(deps, purchaseId);

    const requestIds = paypal.callsTo('refundCapture').map(([call]) => call.requestId);
    expect(requestIds).toEqual([`${purchaseId}:refund`, `${purchaseId}:refund`]);
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId }).from(refunds)).toEqual([
      { paypalRefundId: paypal.refunds[0].refundId },
    ]);
  });

  it('keeps a refund whose answer is lost twice on record, and the purchase captured', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    paypal.failNext('refundCapture', 'lost_response');
    paypal.failNext('refundCapture', 'lost_response');

    await deliverToSeller(deps, purchaseId);

    // PayPal did refund, so the purchase must not look as if its money is settled either way.
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId, status: refunds.status }).from(refunds)).toEqual([
      { paypalRefundId: null, status: 'PENDING' },
    ]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_unknown', data: { requestId: `${purchaseId}:refund`, error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('keeps the purchase captured when PayPal answers the refund in a status that returns nothing', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    vi.spyOn(paypal, 'refundCapture').mockResolvedValue({ refundId: 'REFUND-9', status: 'FAILED' });

    await deliverToSeller(deps, purchaseId);

    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId, status: refunds.status }).from(refunds)).toEqual([
      { paypalRefundId: 'REFUND-9', status: 'FAILED' },
    ]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_failed', data: { refundId: 'REFUND-9', status: 'FAILED', amountCents: seededCart.totalCents } },
    ]);
  });

  it('leaves the purchase captured, refunding and paying nothing, when the seller cannot be reached', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'unreachable';

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(paypal.payouts).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_unknown', data: { error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('does not refund a rejected order whose seller has a payout on record', async () => {
    const { db, deps, paypal, seller, purchaseId, sellerId } = await setUpReceipted();
    seller.mode = 'reject';
    await db.insert(payouts).values({ purchaseId, sellerId, amountCents: seededCart.totalCents, senderBatchId: `${purchaseId}:payout` });

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_skipped', data: { reason: 'the seller has a payout on record' } },
    ]);
  });

  it('refunds nothing and leaves an outside refund of the capture untouched when the seller rejects the order', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    const outside = { purchaseId, amountCents: 500, paypalRefundId: 'REFUND-OUTSIDE', status: 'COMPLETED', reason: null };
    await db.insert(refunds).values(outside);

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([expect.objectContaining(outside)]);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_skipped', data: { reason: 'the capture has another refund on record' } },
    ]);
  });

  it("marks Behest's own refund row with the exact note it sends the buyer, which is how it is told from any other refund", async () => {
    const { db, deps, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';

    await deliverToSeller(deps, purchaseId);

    expect(await db.select({ reason: refunds.reason }).from(refunds)).toEqual([
      { reason: `The seller did not accept Behest order ${purchaseId}.` },
    ]);
  });

  it('treats a refund row with any other note as not its own, and refunds nothing', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    await db.insert(refunds).values({ purchaseId, amountCents: 1875, reason: 'Refunded at PayPal by an operator.' });

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect((await eventsAfterReceipt(db, purchaseId)).at(-1)).toEqual({
      kind: 'refund_skipped',
      data: { reason: 'the capture has another refund on record' },
    });
  });

  it('refunds nothing when the purchase has moved on by the time the seller rejects it', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    seller.whileDeciding = async () => {
      await db.update(purchases).set({ status: 'accepted' }).where(eq(purchases.id, purchaseId));
    };

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_skipped', data: { reason: 'the purchase is accepted' } },
    ]);
  });

  it.each([
    ['replayed', 0],
    ['expired', 16 * 60 * 1000],
  ])('refunds nothing when a second delivery is rejected as %s after the seller accepted the first', async (reason, later) => {
    const { db, deps, paypal, seller, clock, purchaseId } = await setUpReceipted();
    seller.mode = 'lose_answer';
    await deliverToSeller(deps, purchaseId);
    seller.mode = 'verify';
    clock.now = new Date(clock.now.getTime() + later);

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toHaveLength(2);
    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_unknown', data: { error: 'fetch failed', errorClass: 'TypeError' } },
      { kind: 'seller_ambiguous', data: { reason } },
    ]);
  });

  it('does not hand over a purchase that is no longer captured', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    await db.update(purchases).set({ status: 'accepted' }).where(eq(purchases.id, purchaseId));

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toEqual([]);
    expect(paypal.payouts).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([]);
  });
});

describe('retryLostRefund', () => {
  /** A rejected order whose refund PayPal carried out but whose answer was lost twice. */
  async function setUpLostRefund({ refunded = true }: { refunded?: boolean } = {}) {
    const s = await setUpReceipted();
    s.seller.mode = 'reject';
    const failure = refunded ? 'lost_response' : 'network';
    s.paypal.failNext('refundCapture', failure);
    s.paypal.failNext('refundCapture', failure);
    await deliverToSeller(s.deps, s.purchaseId);
    return s;
  }

  it('asks PayPal again under the first request id and note, recording the one refund it made', async () => {
    const { db, deps, paypal, purchaseId } = await setUpLostRefund();

    expect(await retryLostRefund(deps, purchaseId)).toBe(true);

    const calls = paypal.callsTo('refundCapture').map(([call]) => call);
    expect(new Set(calls.map((call) => JSON.stringify(call))).size).toBe(1);
    expect(calls[0]).toMatchObject({ requestId: `${purchaseId}:refund`, note: `The seller did not accept Behest order ${purchaseId}.` });
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId, status: refunds.status }).from(refunds)).toEqual([
      { paypalRefundId: paypal.refunds[0].refundId, status: 'COMPLETED' },
    ]);
    expect((await eventsAfterReceipt(db, purchaseId)).map((e) => e.kind)).toEqual([
      'seller_rejected',
      'refund_unknown',
      'refund',
      'status',
    ]);
  });

  it('refunds now when PayPal never received the first request', async () => {
    const { db, deps, paypal, purchaseId } = await setUpLostRefund({ refunded: false });
    expect(paypal.refunds).toEqual([]);

    await retryLostRefund(deps, purchaseId);

    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
  });

  it('logs refund_unknown again when the answer is lost again, keeping the purchase captured', async () => {
    const { db, deps, paypal, purchaseId } = await setUpLostRefund();
    paypal.failNext('refundCapture', 'network');
    paypal.failNext('refundCapture', 'network');

    await retryLostRefund(deps, purchaseId);

    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect((await eventsAfterReceipt(db, purchaseId)).map((e) => e.kind)).toEqual(['seller_rejected', 'refund_unknown', 'refund_unknown']);
  });

  it.each([
    ['the purchase is no longer captured', async (db: PurchaseDeps['db'], purchaseId: string) => {
      await db.update(purchases).set({ status: 'accepted' }).where(eq(purchases.id, purchaseId));
    }],
    ['the seller has a payout on record', async (db: PurchaseDeps['db'], purchaseId: string, sellerId: string) => {
      await db.insert(payouts).values({ purchaseId, sellerId, amountCents: seededCart.totalCents, senderBatchId: `${purchaseId}:payout` });
    }],
    ['its refund has been recorded since', async (db: PurchaseDeps['db']) => {
      await db.update(refunds).set({ paypalRefundId: 'REFUND-1', status: 'COMPLETED' });
    }],
  ])('asks PayPal nothing when %s', async (_, change) => {
    const { db, deps, paypal, purchaseId, sellerId } = await setUpLostRefund();
    await change(db, purchaseId, sellerId);
    const asked = paypal.calls.length;

    expect(await retryLostRefund(deps, purchaseId)).toBe(false);

    expect(paypal.calls).toHaveLength(asked);
  });
});
