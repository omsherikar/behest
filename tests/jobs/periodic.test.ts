import { and, eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchaseEvents, purchases, refunds, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { runPeriodicPass } from '@/lib/jobs/periodic';
import { deliverToSeller } from '@/lib/purchases/deliver';
import { issueReceipt } from '@/lib/purchases/receipt';
import { COUNTS_AGAINST_BUDGET } from '@/lib/purchases/transitions';
import { setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const MINUTE = 60 * 1000;

// Event rows are stamped by the database's clock, so the pass's clock starts from the real time.
const startOf = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Runs the periodic pass with the clock at `at`; the fake seller reads the same clock. */
async function passAt(s: Pick<Setup, 'deps' | 'clock'>, at: Date): Promise<void> {
  s.clock.now = at;
  await runPeriodicPass(s.deps);
}

async function queuedJobs(db: Db, kind: string) {
  return db
    .select({ payload: jobs.payload, runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.status, 'queued')));
}

/** Another purchase of the seeded buyer from the seeded seller, in `status`, holding no PayPal ids. */
async function addPurchase(db: Db, seededId: string, status: PurchaseStatus, changes: Partial<typeof purchases.$inferInsert> = {}) {
  const [row] = await db.select().from(purchases).where(eq(purchases.id, seededId));
  const { id: _id, createdAt: _created, updatedAt: _updated, ...copy } = row;
  const [added] = await db
    .insert(purchases)
    .values({ ...copy, status, paypalOrderId: null, paypalCaptureId: null, capturedAt: null, ...changes })
    .returning({ id: purchases.id });
  return added.id;
}

async function addPayout(db: Db, purchaseId: string, sellerId: string, status: string, paypalBatchId: string | null) {
  await db.insert(payouts).values({ purchaseId, sellerId, amountCents: 1875, senderBatchId: `${purchaseId}:payout`, paypalBatchId, status });
}

describe('runPeriodicPass: dispute sync', () => {
  it('queues one dispute sync, due now, when none is queued, and no second one on the next pass', async () => {
    const s = await setUp('settled');
    const t = startOf();

    await passAt(s, t);
    await passAt(s, later(t, MINUTE));

    expect(await queuedJobs(s.db, 'dispute_sync')).toEqual([{ payload: {}, runAt: t }]);
  });

  it.each(['done', 'dead'] as const)('queues the next sync ten minutes after the last one ran, which ended %s', async (status) => {
    const s = await setUp('settled');
    const t = startOf();
    await s.db.insert(jobs).values({ kind: 'dispute_sync', payload: {}, status, runAt: later(t, -3 * MINUTE) });

    await passAt(s, t);

    expect(await queuedJobs(s.db, 'dispute_sync')).toEqual([{ payload: {}, runAt: later(t, 7 * MINUTE) }]);
  });

  it('leaves a sync already queued or running as the only one', async () => {
    const s = await setUp('settled');
    const t = startOf();
    await s.db.insert(jobs).values({ kind: 'dispute_sync', payload: {}, status: 'running', runAt: t });

    await passAt(s, t);

    expect(await s.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.kind, 'dispute_sync'))).toEqual([{ status: 'running' }]);
  });
});

describe('runPeriodicPass: payout polls', () => {
  it('queues one poll for every payout PayPal has not finished, refunded purchases included, once', async () => {
    const s = await setUp('accepted');
    const t = startOf();
    const pending = s.purchaseId;
    const unclaimed = await addPurchase(s.db, s.purchaseId, 'refunded');
    const resend = await addPurchase(s.db, s.purchaseId, 'accepted');
    const paid = await addPurchase(s.db, s.purchaseId, 'settled');
    const returned = await addPurchase(s.db, s.purchaseId, 'accepted');
    const unsendable = await addPurchase(s.db, s.purchaseId, 'refunded');
    await addPayout(s.db, pending, s.sellerId, 'PENDING', 'BATCH-1');
    await addPayout(s.db, unclaimed, s.sellerId, 'UNCLAIMED', 'BATCH-2');
    // No batch yet: the poll sends the payout again, which it does only for an accepted purchase.
    await addPayout(s.db, resend, s.sellerId, 'PENDING', null);
    await addPayout(s.db, paid, s.sellerId, 'SUCCESS', 'BATCH-4');
    await addPayout(s.db, returned, s.sellerId, 'RETURNED', 'BATCH-5');
    await addPayout(s.db, unsendable, s.sellerId, 'PENDING', null);

    await passAt(s, t);
    await passAt(s, later(t, MINUTE));

    const polls = await queuedJobs(s.db, 'payout_poll');
    expect(polls.map((job) => job.payload.purchaseId).sort()).toEqual([pending, unclaimed, resend].sort());
    expect(polls.every((job) => job.runAt.getTime() === t.getTime())).toBe(true);
  });

  it('queues no second poll for a payout whose poll is queued or running', async () => {
    const s = await setUp('accepted');
    const t = startOf();
    const running = await addPurchase(s.db, s.purchaseId, 'accepted');
    await addPayout(s.db, s.purchaseId, s.sellerId, 'PENDING', 'BATCH-1');
    await addPayout(s.db, running, s.sellerId, 'PENDING', 'BATCH-2');
    await enqueue(s.db, 'payout_poll', { purchaseId: s.purchaseId }, later(t, 8 * MINUTE));
    await s.db.insert(jobs).values({ kind: 'payout_poll', payload: { purchaseId: running }, status: 'running', runAt: t });

    await passAt(s, t);

    expect(await s.db.select({ payload: jobs.payload, status: jobs.status }).from(jobs).where(eq(jobs.kind, 'payout_poll'))).toHaveLength(2);
  });
});

describe('runPeriodicPass: abandoned proposals', () => {
  it('fails a purchase left proposed for more than 15 minutes, releasing its budget, once', async () => {
    const s = await setUp('proposed');
    const t = startOf();
    await s.db.update(purchases).set({ createdAt: later(t, -16 * MINUTE) }).where(eq(purchases.id, s.purchaseId));

    await passAt(s, t);
    await passAt(s, later(t, MINUTE));

    expect(await statusOf(s.db, s.purchaseId)).toBe('failed');
    expect(COUNTS_AGAINST_BUDGET).not.toContain('failed');
    expect(await eventsOf(s.db, s.purchaseId)).toEqual([
      { kind: 'proposal_abandoned', data: { proposedAt: later(t, -16 * MINUTE).toISOString() } },
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
    expect(s.paypal.calls).toEqual([]);
  });

  it('leaves a purchase proposed less than 15 minutes ago alone', async () => {
    const s = await setUp('proposed');
    const t = startOf();
    await s.db.update(purchases).set({ createdAt: later(t, -14 * MINUTE) }).where(eq(purchases.id, s.purchaseId));

    await passAt(s, t);

    expect(await statusOf(s.db, s.purchaseId)).toBe('proposed');
    expect(await eventsOf(s.db, s.purchaseId)).toEqual([]);
  });
});

describe('runPeriodicPass: undelivered orders', () => {
  /** A purchase captured `ago` before `t`, its receipt issued (unless told not to) and never delivered. */
  async function setUpUndelivered(t: Date, ago: number, { receipt = true } = {}) {
    const s = await setUpCaptured();
    s.clock.now = later(t, -ago);
    await s.db.update(purchases).set({ capturedAt: later(t, -ago) }).where(eq(purchases.id, s.purchaseId));
    if (receipt) await issueReceipt(s.deps, s.purchaseId);
    return s;
  }

  it('delivers again an order captured more than 5 minutes ago that its seller never answered, once', async () => {
    const t = startOf();
    const s = await setUpUndelivered(t, 6 * MINUTE);

    await passAt(s, t);
    await passAt(s, later(t, 10 * MINUTE));

    expect(s.seller.orders).toHaveLength(1);
    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
    expect(s.paypal.payouts).toHaveLength(1);
  });

  it('issues the receipt first for a captured order that never got one', async () => {
    const t = startOf();
    const s = await setUpUndelivered(t, 6 * MINUTE, { receipt: false });

    await passAt(s, t);

    expect((await eventsOf(s.db, s.purchaseId)).map((e) => e.kind)).toContain('receipt');
    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
  });

  it('leaves an order captured less than 5 minutes ago to its first delivery', async () => {
    const t = startOf();
    const s = await setUpUndelivered(t, 4 * MINUTE);

    await passAt(s, t);

    expect(s.seller.orders).toEqual([]);
    expect(await statusOf(s.db, s.purchaseId)).toBe('captured');
  });

  it('waits 5 minutes after an unanswered delivery, then never refunds when the seller calls the redelivery replayed', async () => {
    const t = startOf();
    const s = await setUpUndelivered(t, 10 * MINUTE, { receipt: false });
    s.clock.now = t;
    await issueReceipt(s.deps, s.purchaseId);
    // The seller accepts the first delivery, but its answer is lost: `seller_unknown`, stamped now.
    s.seller.mode = 'lose_answer';
    await deliverToSeller(s.deps, s.purchaseId);
    s.seller.mode = 'verify';

    await passAt(s, later(t, MINUTE));
    expect(s.seller.orders).toHaveLength(1);

    await passAt(s, later(t, 6 * MINUTE));
    await passAt(s, later(t, 12 * MINUTE));

    expect(s.seller.orders).toHaveLength(2);
    expect(await statusOf(s.db, s.purchaseId)).toBe('captured');
    expect(s.paypal.callsTo('refundCapture')).toEqual([]);
    expect(await s.db.select().from(refunds)).toEqual([]);
    expect((await eventsOf(s.db, s.purchaseId)).filter((e) => e.kind.startsWith('seller_'))).toEqual([
      { kind: 'seller_unknown', data: { error: 'fetch failed', errorClass: 'TypeError' } },
      { kind: 'seller_ambiguous', data: { reason: 'replayed' } },
    ]);
  });

  it('leaves an order its seller rejected to the refund steps', async () => {
    const t = startOf();
    const s = await setUpUndelivered(t, 10 * MINUTE);
    s.clock.now = t;
    s.seller.mode = 'reject';
    s.paypal.failNext('refundCapture', 'network');
    s.paypal.failNext('refundCapture', 'network');
    await deliverToSeller(s.deps, s.purchaseId);
    s.seller.mode = 'verify';

    await passAt(s, later(t, MINUTE));

    expect(s.seller.orders).toHaveLength(1);
  });
});

describe('runPeriodicPass: lost refunds', () => {
  it('retries a refund whose answer was lost under its own request id, 5 minutes on, once', async () => {
    const t = startOf();
    const s = await setUpCaptured();
    s.clock.now = t;
    await issueReceipt(s.deps, s.purchaseId);
    s.seller.mode = 'reject';
    s.paypal.failNext('refundCapture', 'lost_response');
    s.paypal.failNext('refundCapture', 'lost_response');
    await deliverToSeller(s.deps, s.purchaseId);
    s.seller.mode = 'verify';

    await passAt(s, later(t, MINUTE));
    expect(s.paypal.callsTo('refundCapture')).toHaveLength(2);

    await passAt(s, later(t, 6 * MINUTE));
    await passAt(s, later(t, 12 * MINUTE));

    const requestIds = s.paypal.callsTo('refundCapture').map(([call]) => call.requestId);
    expect(requestIds).toEqual(Array(3).fill(`${s.purchaseId}:refund`));
    expect(s.paypal.refunds).toHaveLength(1);
    expect(await statusOf(s.db, s.purchaseId)).toBe('refunded');
    expect(await s.db.select({ paypalRefundId: refunds.paypalRefundId }).from(refunds)).toEqual([
      { paypalRefundId: s.paypal.refunds[0].refundId },
    ]);
  });
});

describe('runPeriodicPass: payouts left unclaimed after a refund', () => {
  it.each(['UNCLAIMED', 'ONHOLD'])('logs payout_unclaimed_after_refund once for a %s payout of a refunded purchase', async (payoutStatus) => {
    const s = await setUp('refunded');
    const t = startOf();
    await addPayout(s.db, s.purchaseId, s.sellerId, payoutStatus, 'BATCH-1');

    await passAt(s, t);
    await passAt(s, later(t, MINUTE));

    expect((await eventsOf(s.db, s.purchaseId)).filter((e) => e.kind === 'payout_unclaimed_after_refund')).toEqual([
      { kind: 'payout_unclaimed_after_refund', data: { payoutStatus, paypalBatchId: 'BATCH-1' } },
    ]);
  });

  it('logs nothing for an unclaimed payout of a purchase that was not refunded', async () => {
    const s = await setUp('accepted');
    const t = startOf();
    await addPayout(s.db, s.purchaseId, s.sellerId, 'UNCLAIMED', 'BATCH-1');

    await passAt(s, t);

    expect(await eventsOf(s.db, s.purchaseId)).toEqual([]);
  });
});

describe('runPeriodicPass: failures', () => {
  it('logs a purchase it could not deliver and still runs every other step', async () => {
    const t = startOf();
    const s = await setUpCaptured();
    // Captured, but with no capture id, so no receipt can be issued for it.
    await s.db.update(purchases).set({ paypalCaptureId: null, capturedAt: later(t, -10 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    const stale = await addPurchase(s.db, s.purchaseId, 'proposed', { createdAt: later(t, -20 * MINUTE) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await passAt(s, t);

    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0][0])).toContain(s.purchaseId);
    expect(await statusOf(s.db, stale)).toBe('failed');
    expect(await queuedJobs(s.db, 'dispute_sync')).toHaveLength(1);
    expect((await purchaseRow(s.db, s.purchaseId)).status).toBe('captured');
    expect(await s.db.select().from(purchaseEvents).where(eq(purchaseEvents.purchaseId, s.purchaseId))).toEqual([]);
  });
});
