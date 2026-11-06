import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchases, type PurchaseStatus } from '@/lib/db/schema';
import { PayPalApiError } from '@/lib/paypal/http';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import { payoutSeller, pollPayout } from '@/lib/purchases/settle';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { eventsOf, SEEDED_SELLER, seedPurchase, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 30_000);

const NOW = new Date('2026-11-06T12:00:00Z');
const DAY_MS = 86_400_000;

/** A database with one purchase in `status`, a fake PayPal, and the dependencies settling needs. */
async function setUp(status: PurchaseStatus = 'accepted') {
  const db = await createTestDb();
  const paypal = new FakePaypal();
  const { purchaseId, sellerId } = await seedPurchase(db, status);
  return { db, paypal, purchaseId, sellerId, deps: { db, paypal, now: () => NOW } };
}

async function payoutRows(db: Db) {
  return db.select().from(payouts);
}

describe('payoutSeller', () => {
  it('pays the seller the order total, keyed on the purchase', async () => {
    const { db, paypal, purchaseId, sellerId, deps } = await setUp();

    await payoutSeller(deps, purchaseId);

    expect(paypal.callsTo('createPayout')).toEqual([
      [
        {
          senderBatchId: `${purchaseId}:payout`,
          receiverEmail: SEEDED_SELLER.payoutEmail,
          amountCents: seededCart.totalCents,
          note: `Behest order ${purchaseId}`,
        },
      ],
    ]);
    expect(await payoutRows(db)).toEqual([
      expect.objectContaining({
        purchaseId,
        sellerId,
        amountCents: seededCart.totalCents,
        currency: 'USD',
        senderBatchId: `${purchaseId}:payout`,
        paypalBatchId: paypal.payouts[0].payoutBatchId,
        status: 'PENDING',
      }),
    ]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('queues a poll of the payout, due shortly after it is sent', async () => {
    const { db, purchaseId, deps } = await setUp();

    await payoutSeller(deps, purchaseId);

    expect(await db.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs)).toEqual([
      { kind: 'payout_poll', payload: { purchaseId }, runAt: new Date(NOW.getTime() + 30_000) },
    ]);
  });

  it('creates the payout once even if called twice', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();

    await payoutSeller(deps, purchaseId);
    await payoutSeller(deps, purchaseId);

    expect(paypal.callsTo('createPayout')).toHaveLength(1);
    expect(await payoutRows(db)).toHaveLength(1);
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it('creates the payout once when two calls overlap', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();

    await Promise.all([payoutSeller(deps, purchaseId), payoutSeller(deps, purchaseId)]);

    expect(paypal.callsTo('createPayout')).toHaveLength(1);
    expect(await payoutRows(db)).toHaveLength(1);
  });

  it('does nothing for a purchase already settled', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    await payoutSeller(deps, purchaseId);
    await db.update(purchases).set({ status: 'settled' }).where(eq(purchases.id, purchaseId));

    await payoutSeller(deps, purchaseId);

    expect(paypal.callsTo('createPayout')).toHaveLength(1);
  });

  it('pays nothing for a purchase refunded before its payout', async () => {
    const { db, paypal, purchaseId, deps } = await setUp('refunded');

    await payoutSeller(deps, purchaseId);

    expect(paypal.calls).toEqual([]);
    expect(await payoutRows(db)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('refuses to pay for a purchase its seller has not accepted', async () => {
    const { db, paypal, purchaseId, deps } = await setUp('captured');

    await expect(payoutSeller(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} is captured`);

    expect(paypal.calls).toEqual([]);
    expect(await payoutRows(db)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
  });

  it('takes a payout PayPal already has under the sender batch id as sent, keeping its batch id', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    const sent = await paypal.createPayout({
      senderBatchId: `${purchaseId}:payout`,
      receiverEmail: SEEDED_SELLER.payoutEmail,
      amountCents: seededCart.totalCents,
      note: 'sent before',
    });

    await payoutSeller(deps, purchaseId);

    expect(paypal.payouts).toHaveLength(1);
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: sent.payoutBatchId })]);
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('records a payout whose answer was lost, and the poll finds the batch PayPal made without paying twice', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    paypal.failNext('createPayout', 'lost_response');

    await payoutSeller(deps, purchaseId);

    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: null })]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'payout_unknown', data: { error: 'fetch failed', errorClass: 'TypeError' } },
    ]);

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(paypal.payouts).toHaveLength(1);
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: paypal.payouts[0].payoutBatchId })]);
  });

  it('records PayPal refusing the payout with its HTTP status, so a refusal reads apart from a lost answer', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    const refusal = new PayPalApiError(422, '/v1/payments/payouts', JSON.stringify({ name: 'INSUFFICIENT_FUNDS' }));
    vi.spyOn(paypal, 'createPayout').mockRejectedValueOnce(refusal);

    await payoutSeller(deps, purchaseId);

    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'payout_unknown', data: { error: refusal.message, errorClass: 'PayPalApiError', httpStatus: 422 } },
    ]);
  });

  it('records a payout PayPal already has but does not name the batch of', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    const duplicate = new PayPalApiError(400, '/v1/payments/payouts', JSON.stringify({ name: 'USER_BUSINESS_ERROR' }));
    const unnamed = new PayoutAlreadyExists(`${purchaseId}:payout`, null, { cause: duplicate });
    vi.spyOn(paypal, 'createPayout').mockRejectedValueOnce(unnamed);

    await payoutSeller(deps, purchaseId);

    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: null })]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'payout_unknown', data: { error: unnamed.message, errorClass: 'PayoutAlreadyExists', httpStatus: 400 } },
    ]);
  });

  it('sends the payout from the poll when the first request never reached PayPal', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    paypal.failNext('createPayout', 'network');

    await payoutSeller(deps, purchaseId);
    expect(paypal.payouts).toEqual([]);

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(paypal.payouts).toEqual([expect.objectContaining({ senderBatchId: `${purchaseId}:payout`, amountCents: seededCart.totalCents })]);
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: paypal.payouts[0].payoutBatchId })]);
  });
});

describe('pollPayout', () => {
  /** A purchase whose payout has been sent, and the batch PayPal made for it. */
  async function sent() {
    const setup = await setUp();
    await payoutSeller(setup.deps, setup.purchaseId);
    return { ...setup, batchId: setup.paypal.payouts[0].payoutBatchId };
  }

  it('settles the purchase when PayPal reports the item paid', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('settled');
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: 'SUCCESS' })]);
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'status', data: { from: 'accepted', to: 'settled' } }]);
  });

  it('settles on the item status while the batch still reads as processing', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'PROCESSING', itemStatus: 'SUCCESS' });

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('settled');
  });

  it('retries while the payout is pending', async () => {
    const { db, purchaseId, deps } = await sent();

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
  });

  it.each(['UNCLAIMED', 'ONHOLD', 'SOMETHING_NEW'])('retries while the item is %s, recording the status', async (itemStatus) => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus });

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: itemStatus })]);
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('retries while PayPal reports no item yet', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'PENDING', itemStatus: null });

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: 'PENDING' })]);
  });

  it.each(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'])(
    'leaves the purchase accepted and records the status when the item is %s',
    async (itemStatus) => {
      const { db, paypal, purchaseId, deps, batchId } = await sent();
      paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus });

      expect(await pollPayout(deps, purchaseId)).toBe('done');

      expect(await statusOf(db, purchaseId)).toBe('accepted');
      expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: itemStatus })]);
      expect(await eventsOf(db, purchaseId)).toEqual([
        { kind: 'payout_failed', data: { payoutBatchId: batchId, batchStatus: 'SUCCESS', itemStatus } },
      ]);
    },
  );

  it.each(['DENIED', 'CANCELED'])('takes a batch PayPal %s before reporting an item as a failed payout', async (batchStatus) => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus, itemStatus: null });

    expect(await pollPayout(deps, purchaseId)).toBe('done');
    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ status: batchStatus })]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'payout_failed', data: { payoutBatchId: batchId, batchStatus, itemStatus: null } },
    ]);
    expect(paypal.callsTo('getPayoutBatch')).toHaveLength(1);
  });

  it('records a failed payout once, without asking PayPal again', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'RETURNED' });

    await pollPayout(deps, purchaseId);
    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(paypal.callsTo('getPayoutBatch')).toHaveLength(1);
    expect((await eventsOf(db, purchaseId)).map((e) => e.kind)).toEqual(['payout_failed']);
  });

  it('records a failed payout once when two polls overlap', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'FAILED' });

    expect(await Promise.all([pollPayout(deps, purchaseId), pollPayout(deps, purchaseId)])).toEqual(['done', 'done']);

    expect((await eventsOf(db, purchaseId)).map((e) => e.kind)).toEqual(['payout_failed']);
  });

  it('settles once when two polls overlap', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });

    expect(await Promise.all([pollPayout(deps, purchaseId), pollPayout(deps, purchaseId)])).toEqual(['done', 'done']);

    expect(await statusOf(db, purchaseId)).toBe('settled');
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'status', data: { from: 'accepted', to: 'settled' } }]);
  });

  it('is done without asking PayPal once the purchase has settled', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });
    await pollPayout(deps, purchaseId);

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(paypal.callsTo('getPayoutBatch')).toHaveLength(1);
    expect(await eventsOf(db, purchaseId)).toHaveLength(1);
  });

  it('is done without asking PayPal once the purchase has moved on another way', async () => {
    const { db, paypal, purchaseId, deps } = await sent();
    await db.update(purchases).set({ status: 'refunded' }).where(eq(purchases.id, purchaseId));

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(paypal.callsTo('getPayoutBatch')).toEqual([]);
  });

  /** A paid payout whose purchase is refunded while PayPal is first asked about it. */
  async function refundedWhilePolling() {
    const setup = await sent();
    setup.paypal.setPayoutStatus(setup.batchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });
    const ask = setup.paypal.getPayoutBatch.bind(setup.paypal);
    vi.spyOn(setup.paypal, 'getPayoutBatch').mockImplementationOnce(async (id) => {
      await setup.db.update(purchases).set({ status: 'refunded' }).where(eq(purchases.id, setup.purchaseId));
      return ask(id);
    });
    return setup;
  }

  it('leaves a purchase refunded while PayPal was asked where it is, and records that the seller was paid anyway', async () => {
    const { db, purchaseId, deps } = await refundedWhilePolling();

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'payout_after_refund', data: { status: 'refunded' } }]);
  });

  it('records a payout after a refund once when two polls overlap', async () => {
    const { db, purchaseId, deps } = await refundedWhilePolling();

    expect(await Promise.all([pollPayout(deps, purchaseId), pollPayout(deps, purchaseId)])).toEqual(['done', 'done']);

    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'payout_after_refund', data: { status: 'refunded' } }]);
  });

  it('fails, to be retried, when PayPal has the payout but does not say which batch it is', async () => {
    const { db, paypal, purchaseId, deps } = await setUp();
    paypal.failNext('createPayout', 'network');
    await payoutSeller(deps, purchaseId);
    vi.spyOn(paypal, 'createPayout').mockRejectedValueOnce(new PayoutAlreadyExists(`${purchaseId}:payout`, null));

    await expect(pollPayout(deps, purchaseId)).rejects.toThrow(`${purchaseId}:payout`);

    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: null })]);
    expect(paypal.callsTo('getPayoutBatch')).toEqual([]);
  });

  describe('a payout whose first request may not have reached PayPal', () => {
    /** The payout, never answered, and the settling dependencies with the clock `ms` after its row was written. */
    async function unanswered() {
      const setup = await setUp();
      setup.paypal.failNext('createPayout', 'network');
      await payoutSeller(setup.deps, setup.purchaseId);
      const [{ createdAt }] = await payoutRows(setup.db);
      const after = (ms: number) => ({ ...setup.deps, now: () => new Date(createdAt.getTime() + ms) });
      return { ...setup, after };
    }

    it('is resent up to 29 days after it was written', async () => {
      const { paypal, purchaseId, after } = await unanswered();

      expect(await pollPayout(after(29 * DAY_MS), purchaseId)).toBe('retry');

      expect(paypal.payouts).toHaveLength(1);
    });

    it('is not resent once older, since PayPal remembers a sender batch id for only 30 days', async () => {
      const { db, paypal, purchaseId, after } = await unanswered();

      await expect(pollPayout(after(29 * DAY_MS + 1), purchaseId)).rejects.toThrow(
        `payout ${purchaseId}:payout is too old to resend safely; check PayPal before paying again`,
      );

      expect(paypal.callsTo('createPayout')).toHaveLength(1);
      expect(paypal.payouts).toEqual([]);
      expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: null, status: 'PENDING' })]);
    });
  });

  it('refuses to poll a purchase that has no payout', async () => {
    const { purchaseId, deps } = await setUp();

    await expect(pollPayout(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} has no payout`);
  });
});
