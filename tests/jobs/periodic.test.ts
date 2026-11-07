import { and, eq, sql } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchaseEvents, purchases, refunds, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { runPeriodicPass } from '@/lib/jobs/periodic';
import * as schema from '@/lib/db/schema';
import { deliverToSeller } from '@/lib/purchases/deliver';
import { appendEvent } from '@/lib/purchases/events';
import { issueReceipt } from '@/lib/purchases/receipt';
import { COUNTS_AGAINST_BUDGET } from '@/lib/purchases/transitions';
import { setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// Every enqueue goes through to the real queue unless a test makes one fail.
vi.mock('@/lib/jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/jobs/queue')>();
  return { ...actual, enqueue: vi.fn(actual.enqueue) };
});

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
  const { buyerId, mandateId, sellerId, request, proposal, cart, cartHash, totalCents } = row;
  const { gateVerdict, gateReasons, gateOutcomes, rulesetVersion, intent, finalVerdict, approver } = row;
  const copy = {
    ...{ buyerId, mandateId, sellerId, request, proposal, cart, cartHash, totalCents },
    ...{ gateVerdict, gateReasons, gateOutcomes, rulesetVersion, intent, finalVerdict, approver },
  };
  const [added] = await db
    .insert(purchases)
    .values({ ...copy, status, ...changes })
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

describe('runPeriodicPass: payout polls after earlier ones ended', () => {
  it('polls an unfinished payout again only once its last poll ended more than an hour ago', async () => {
    const s = await setUp('accepted');
    const t = startOf();
    const recent = await addPurchase(s.db, s.purchaseId, 'refunded');
    await addPayout(s.db, s.purchaseId, s.sellerId, 'UNCLAIMED', 'BATCH-1');
    await addPayout(s.db, recent, s.sellerId, 'ONHOLD', 'BATCH-2');
    await s.db.insert(jobs).values([
      { kind: 'payout_poll', payload: { purchaseId: s.purchaseId }, status: 'dead', runAt: later(t, -61 * MINUTE) },
      { kind: 'payout_poll', payload: { purchaseId: recent }, status: 'dead', runAt: later(t, -30 * MINUTE) },
    ]);

    await passAt(s, t);

    expect((await queuedJobs(s.db, 'payout_poll')).map((job) => job.payload.purchaseId)).toEqual([s.purchaseId]);
  });

  it('queues the other payouts when queuing one fails, logging the one that failed', async () => {
    const s = await setUp('accepted');
    const t = startOf();
    const second = await addPurchase(s.db, s.purchaseId, 'accepted');
    await addPayout(s.db, s.purchaseId, s.sellerId, 'PENDING', 'BATCH-1');
    await addPayout(s.db, second, s.sellerId, 'PENDING', 'BATCH-2');
    // A dispute sync already queued, so the first enqueue of the pass is the oldest payout's poll.
    await s.db.insert(jobs).values({ kind: 'dispute_sync', payload: {}, status: 'queued', runAt: later(t, MINUTE) });
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('insert failed'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await passAt(s, t);

    expect((await queuedJobs(s.db, 'payout_poll')).map((job) => job.payload.purchaseId)).toEqual([second]);
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0][0])).toContain(s.purchaseId);
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
      { kind: 'status', data: { from: 'proposed', to: 'failed' } },
    ]);
    expect(s.paypal.calls).toEqual([]);
  });

  it('fails at most 10 a pass, oldest first, leaving the rest for the next pass', async () => {
    const s = await setUp('proposed');
    const t = startOf();
    await s.db.update(purchases).set({ createdAt: later(t, -60 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    const added: string[] = [];
    for (let i = 0; i < 10; i++) added.push(await addPurchase(s.db, s.purchaseId, 'proposed', { createdAt: later(t, -(40 - i) * MINUTE) }));
    const newest = added.at(-1) as string;

    await passAt(s, t);

    expect(await statusOf(s.db, s.purchaseId)).toBe('failed');
    expect(await statusOf(s.db, newest)).toBe('proposed');
    const failed = await s.db.select({ id: purchases.id }).from(purchases).where(eq(purchases.status, 'failed'));
    expect(failed).toHaveLength(10);

    await passAt(s, later(t, MINUTE));

    expect(await statusOf(s.db, newest)).toBe('failed');
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

  it.each([
    [11, 'delivers it a twelfth time'],
    [12, 'stops and logs seller_unreachable once'],
  ])('after %i unanswered deliveries %s', async (unanswered) => {
    const t = startOf();
    const s = await setUpUndelivered(t, 2 * 60 * MINUTE, { receipt: false });
    s.clock.now = t;
    await issueReceipt(s.deps, s.purchaseId);
    for (let i = 0; i < unanswered; i++) await appendEvent(s.db, s.purchaseId, 'seller_unknown', { error: 'fetch failed' });

    await passAt(s, later(t, 6 * MINUTE));
    await passAt(s, later(t, 12 * MINUTE));

    const flags = (await eventsOf(s.db, s.purchaseId)).filter((e) => e.kind === 'seller_unreachable');
    if (unanswered < 12) {
      expect(s.seller.orders).toHaveLength(1);
      expect(flags).toEqual([]);
    } else {
      expect(s.seller.orders).toEqual([]);
      expect(flags).toEqual([{ kind: 'seller_unreachable', data: { attempts: 12 } }]);
      expect(await statusOf(s.db, s.purchaseId)).toBe('captured');
    }
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

describe('runPeriodicPass: lost refunds that never get an answer', () => {
  /** A rejected order with Behest's own refund on record, whose answer was lost `lost` times. */
  async function setUpLostTimes(t: Date, lost: number) {
    const s = await setUpCaptured();
    s.clock.now = t;
    await s.db.insert(refunds).values({
      purchaseId: s.purchaseId,
      amountCents: 1875,
      reason: `The seller did not accept Behest order ${s.purchaseId}.`,
    });
    await appendEvent(s.db, s.purchaseId, 'seller_rejected', { reason: 'out_of_stock' });
    for (let i = 0; i < lost; i++) await appendEvent(s.db, s.purchaseId, 'refund_unknown', { requestId: `${s.purchaseId}:refund` });
    return s;
  }

  it('asks PayPal a twelfth time after 11 lost answers', async () => {
    const t = startOf();
    const s = await setUpLostTimes(t, 11);

    await passAt(s, later(t, 6 * MINUTE));

    expect(s.paypal.callsTo('refundCapture').map(([call]) => call.requestId)).toEqual([`${s.purchaseId}:refund`]);
  });

  it('stops after 12 lost answers and logs refund_stuck once, asking PayPal nothing', async () => {
    const t = startOf();
    const s = await setUpLostTimes(t, 12);

    await passAt(s, later(t, 6 * MINUTE));
    await passAt(s, later(t, 12 * MINUTE));

    expect(s.paypal.callsTo('refundCapture')).toEqual([]);
    expect((await eventsOf(s.db, s.purchaseId)).filter((e) => e.kind === 'refund_stuck')).toEqual([
      { kind: 'refund_stuck', data: { attempts: 12 } },
    ]);
    expect(await statusOf(s.db, s.purchaseId)).toBe('captured');
  });
});

describe('runPeriodicPass: a minute of outside calls', () => {
  it('stops calling the seller and PayPal once the pass has run a minute, and picks up the rest next pass', async () => {
    const t = startOf();
    const s = await setUpCaptured();
    s.clock.now = later(t, -10 * MINUTE);
    await s.db.update(purchases).set({ capturedAt: later(t, -10 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    // A second undelivered order, captured a minute later, and a lost refund on a rejected third.
    const second = await addPurchase(s.db, s.purchaseId, 'captured', {
      paypalOrderId: 'ORDER-B',
      paypalCaptureId: 'CAPTURE-B',
      capturedAt: later(t, -9 * MINUTE),
    });
    const rejected = await addPurchase(s.db, s.purchaseId, 'captured', {
      paypalOrderId: 'ORDER-C',
      paypalCaptureId: 'CAPTURE-C',
      capturedAt: later(t, -9 * MINUTE),
    });
    await s.db.insert(refunds).values({ purchaseId: rejected, amountCents: 1875, reason: `The seller did not accept Behest order ${rejected}.` });
    await appendEvent(s.db, rejected, 'seller_rejected', { reason: 'out_of_stock' });
    await appendEvent(s.db, rejected, 'refund_unknown', { requestId: `${rejected}:refund` });
    // The first delivery takes the seller 61 seconds.
    let slow = true;
    s.seller.whileDeciding = async () => {
      if (slow) s.clock.now = later(s.clock.now, 61 * 1000);
      slow = false;
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await passAt(s, later(t, 6 * MINUTE));

    expect(s.seller.orders).toHaveLength(1);
    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
    expect(await statusOf(s.db, second)).toBe('captured');
    expect(s.paypal.callsTo('refundCapture')).toEqual([]);

    await passAt(s, later(t, 8 * MINUTE));

    expect(s.seller.orders).toHaveLength(2);
    expect(await statusOf(s.db, second)).toBe('accepted');
    expect(s.paypal.callsTo('refundCapture').map(([call]) => call.requestId)).toEqual(Array(2).fill(`${rejected}:refund`));
    // The fake PayPal holds no CAPTURE-C, so it refuses that refund twice; the refund flow records
    // that on the purchase as refund_unknown, and nothing is thrown.
    expect(errors).not.toHaveBeenCalled();
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

describe('runPeriodicPass: purchases left charging', () => {
  it('logs charge_stale once for a purchase charging untouched for more than 30 minutes, and moves no money', async () => {
    const s = await setUp('charging');
    const t = startOf();
    const lastChange = later(t, -31 * MINUTE);
    await s.db
      .update(purchases)
      .set({ paypalOrderId: 'ORDER-1', paypalCaptureId: 'CAPTURE-1', updatedAt: lastChange })
      .where(eq(purchases.id, s.purchaseId));

    await passAt(s, t);
    await passAt(s, later(t, MINUTE));

    expect(await eventsOf(s.db, s.purchaseId)).toEqual([
      {
        kind: 'charge_stale',
        data: { updatedAt: lastChange.toISOString(), paypalOrderId: 'ORDER-1', paypalCaptureId: 'CAPTURE-1' },
      },
    ]);
    expect(await statusOf(s.db, s.purchaseId)).toBe('charging');
    expect(s.paypal.calls).toEqual([]);
  });

  it('leaves a purchase charging for less than 30 minutes alone', async () => {
    const s = await setUp('charging');
    const t = startOf();
    await s.db.update(purchases).set({ updatedAt: later(t, -29 * MINUTE) }).where(eq(purchases.id, s.purchaseId));

    await passAt(s, t);

    expect(await eventsOf(s.db, s.purchaseId)).toEqual([]);
  });

  it('flags at most 10 a pass, oldest first, leaving the rest for the next pass', async () => {
    const s = await setUp('charging');
    const t = startOf();
    await s.db.update(purchases).set({ updatedAt: later(t, -60 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    const added: string[] = [];
    for (let i = 0; i < 10; i++) added.push(await addPurchase(s.db, s.purchaseId, 'charging', { updatedAt: later(t, -(50 - i) * MINUTE) }));
    const newest = added.at(-1) as string;
    const flagged = () => s.db.select({ id: purchaseEvents.purchaseId }).from(purchaseEvents).where(eq(purchaseEvents.kind, 'charge_stale'));

    await passAt(s, t);

    expect((await flagged()).map((row) => row.id)).not.toContain(newest);
    expect(await flagged()).toHaveLength(10);

    await passAt(s, later(t, MINUTE));

    expect((await flagged()).map((row) => row.id)).toContain(newest);
  });
});

describe('runPeriodicPass: one pass at a time', () => {
  it('skips a pass that starts while another is still running in this process', async () => {
    const t = startOf();
    const s = await setUpCaptured();
    s.clock.now = t;
    await s.db.update(purchases).set({ capturedAt: later(t, -10 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    const deciding = Promise.withResolvers<void>();
    const decided = Promise.withResolvers<void>();
    s.seller.whileDeciding = async () => {
      deciding.resolve();
      await decided.promise;
    };

    const first = runPeriodicPass(s.deps);
    await deciding.promise;
    await runPeriodicPass(s.deps);
    decided.resolve();
    await first;

    expect(s.seller.orders).toHaveLength(1);
    expect(await queuedJobs(s.db, 'dispute_sync')).toHaveLength(1);
  });

  /** A database over a real pg Pool whose one client is a stand-in that answers the lock query with `locked`. */
  function lockedPool(locked: boolean, { unlockFails = false } = {}) {
    const pool = new Pool({ connectionString: 'postgres://behest@127.0.0.1:1/never' });
    const statements: string[] = [];
    const client = {
      query: vi.fn<(text: string, values?: unknown[]) => Promise<{ rows: { locked: boolean }[] }>>(async (text) => {
        statements.push(text);
        if (text.includes('pg_advisory_unlock') && unlockFails) throw new Error('connection reset');
        return { rows: [{ locked }] };
      }),
      release: vi.fn(),
    };
    vi.spyOn(pool, 'connect').mockImplementation(async () => client as unknown as PoolClient);
    const poolQuery = vi.spyOn(pool, 'query').mockImplementation(async () => {
      throw new Error('the steps do not reach this database');
    });
    const db = drizzlePg({ client: pool, schema });
    const deps = { db, now: () => startOf() } as unknown as Parameters<typeof runPeriodicPass>[0];
    return { deps, client, statements, poolQuery };
  }

  it('skips the pass, running no step, while another worker holds the Postgres lock', async () => {
    const { deps, client, statements, poolQuery } = lockedPool(false);

    await runPeriodicPass(deps);

    expect(statements).toEqual(['select pg_try_advisory_lock($1) as locked']);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('runs the steps while it holds the Postgres lock on one client, then unlocks and returns that client', async () => {
    const { deps, client, statements, poolQuery } = lockedPool(true);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPeriodicPass(deps);

    expect(poolQuery).toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    expect(statements).toEqual(['select pg_try_advisory_lock($1) as locked', 'select pg_advisory_unlock($1)']);
    expect(client.query.mock.calls.map(([, values]) => values)).toEqual([[4_242_001], [4_242_001]]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('closes the client instead of returning it when unlocking fails, which releases the lock', async () => {
    const { deps, client } = lockedPool(true, { unlockFails: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runPeriodicPass(deps);

    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('runPeriodicPass: failures', () => {
  it('logs a step that fails as a whole and still runs every other step', async () => {
    const t = startOf();
    const s = await setUp('proposed');
    await s.db.update(purchases).set({ createdAt: later(t, -20 * MINUTE) }).where(eq(purchases.id, s.purchaseId));
    await s.db.execute(sql`drop table refunds`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await passAt(s, t);

    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0][0])).toMatch(/^Periodic pass step "lost refunds" failed: /);
    expect(await statusOf(s.db, s.purchaseId)).toBe('failed');
    expect(await queuedJobs(s.db, 'dispute_sync')).toHaveLength(1);
  });

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
