import { asc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchaseEvents, purchases, type PurchaseStatus } from '@/lib/db/schema';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import { payoutSeller, pollPayout } from '@/lib/purchases/settle';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { SEEDED_SELLER, seedPurchase, seededCart } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 30_000);

const NOW = new Date('2026-11-06T12:00:00Z');

/** A database with one purchase in `status`, a fake PayPal, and the dependencies settling needs. */
async function setUp(status: PurchaseStatus = 'accepted') {
  const db = await createTestDb();
  const paypal = new FakePaypal();
  const { purchaseId, sellerId } = await seedPurchase(db, status);
  return { db, paypal, purchaseId, sellerId, deps: { db, paypal, now: () => NOW } };
}

async function statusOf(db: Db, purchaseId: string) {
  const [row] = await db.select({ status: purchases.status }).from(purchases).where(eq(purchases.id, purchaseId));
  return row.status;
}

async function payoutRows(db: Db) {
  return db.select().from(payouts);
}

async function eventsOf(db: Db, purchaseId: string) {
  return db
    .select({ kind: purchaseEvents.kind, data: purchaseEvents.data })
    .from(purchaseEvents)
    .where(eq(purchaseEvents.purchaseId, purchaseId))
    .orderBy(asc(purchaseEvents.seq));
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
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'payout_unknown', data: { error: 'fetch failed' } }]);

    expect(await pollPayout(deps, purchaseId)).toBe('retry');

    expect(paypal.payouts).toHaveLength(1);
    expect(await payoutRows(db)).toEqual([expect.objectContaining({ paypalBatchId: paypal.payouts[0].payoutBatchId })]);
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

  it('leaves a purchase that moved on while PayPal was asked where it is', async () => {
    const { db, paypal, purchaseId, deps, batchId } = await sent();
    paypal.setPayoutStatus(batchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });
    const ask = paypal.getPayoutBatch.bind(paypal);
    vi.spyOn(paypal, 'getPayoutBatch').mockImplementationOnce(async (id) => {
      await db.update(purchases).set({ status: 'refunded' }).where(eq(purchases.id, purchaseId));
      return ask(id);
    });

    expect(await pollPayout(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await eventsOf(db, purchaseId)).toEqual([]);
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

  it('refuses to poll a purchase that has no payout', async () => {
    const { purchaseId, deps } = await setUp();

    await expect(pollPayout(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} has no payout`);
  });
});
