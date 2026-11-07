import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, purchases, webhookEvents } from '@/lib/db/schema';
import { jobHandlers } from '@/lib/jobs/handlers';
import { enqueue, runDueJobs } from '@/lib/jobs/queue';
import { startApproval } from '@/lib/purchases/approval';
import { chargeAllowed } from '@/lib/purchases/charge';
import { payoutSeller } from '@/lib/purchases/settle';
import { NOW, setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { purchaseRow, statusOf } from '@/tests/helpers/seed-purchase';
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
const after = (ms: number) => new Date(NOW.getTime() + ms);

type Setup = Awaited<ReturnType<typeof setUp>>;

/** Runs the jobs due at `at` with the app's handlers. */
function runAt(s: Pick<Setup, 'db' | 'deps'>, at: Date): Promise<number> {
  return runDueJobs(s.db, jobHandlers, s.deps, () => at);
}

async function jobRows(db: Db) {
  return db
    .select({ kind: jobs.kind, payload: jobs.payload, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError })
    .from(jobs)
    .orderBy(jobs.createdAt);
}

async function jobOf(db: Db, kind: string) {
  const rows = (await jobRows(db)).filter((job) => job.kind === kind);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** A purchase the gate sent to its buyer, its approval order created at PayPal and approved there. */
async function setUpAwaiting() {
  const s = await setUp('proposed', { wallet: null });
  await s.db
    .update(purchases)
    .set({ gateVerdict: 'ASK', finalVerdict: 'ASK', approver: null })
    .where(eq(purchases.id, s.purchaseId));
  await startApproval(s.deps, s.purchaseId);
  const { paypalOrderId: orderId } = await purchaseRow(s.db, s.purchaseId);
  if (!orderId) throw new Error('the approval was not started');
  s.paypal.approve(orderId);
  return { ...s, orderId };
}

describe('jobHandlers', () => {
  it('payout_poll: follows the payout until PayPal pays the seller, then settles the purchase', async () => {
    const s = await setUp('accepted');
    await payoutSeller(s.deps, s.purchaseId);
    const [{ payoutBatchId }] = s.paypal.payouts;
    s.paypal.setPayoutStatus(payoutBatchId, { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' });

    expect(await runAt(s, after(MINUTE))).toBe(1);

    expect(await statusOf(s.db, s.purchaseId)).toBe('settled');
    expect(await jobOf(s.db, 'payout_poll')).toMatchObject({ payload: { purchaseId: s.purchaseId }, status: 'done' });
  });

  it('payout_poll: runs again later while the payout is still pending', async () => {
    const s = await setUp('accepted');
    await payoutSeller(s.deps, s.purchaseId);

    await runAt(s, after(MINUTE));

    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
    expect(await jobOf(s.db, 'payout_poll')).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('approval_expiry: cancels a purchase its buyer did not approve in time', async () => {
    const s = await setUp('proposed', { wallet: null });
    await s.db.update(purchases).set({ gateVerdict: 'ASK', finalVerdict: 'ASK', approver: null }).where(eq(purchases.id, s.purchaseId));
    await startApproval(s.deps, s.purchaseId);

    expect(await runAt(s, after(3 * 60 * MINUTE))).toBe(1);

    expect(await statusOf(s.db, s.purchaseId)).toBe('cancelled');
    expect(await jobOf(s.db, 'approval_expiry')).toMatchObject({ status: 'done' });
  });

  it('dispute_sync: syncs the disputes PayPal lists', async () => {
    const s = await setUpCaptured();
    await s.db.update(purchases).set({ status: 'settled' }).where(eq(purchases.id, s.purchaseId));
    s.paypal.disputes = [
      { id: 'PP-D-1', status: 'OPEN', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amountCents: 1875, captureId: s.captureId, createTime: NOW.toISOString(), buyerNotes: null, outcome: null },
    ];
    await enqueue(s.db, 'dispute_sync', {}, NOW);

    await runAt(s, NOW);

    expect(await statusOf(s.db, s.purchaseId)).toBe('disputed');
    expect(await jobOf(s.db, 'dispute_sync')).toMatchObject({ status: 'done' });
  });

  it('dispute_sync: runs again later when PayPal cannot list the disputes', async () => {
    const s = await setUp('settled');
    vi.spyOn(s.paypal, 'listDisputes').mockRejectedValue(new TypeError('fetch failed'));
    await enqueue(s.db, 'dispute_sync', {}, NOW);

    await runAt(s, NOW);

    expect(await jobOf(s.db, 'dispute_sync')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'fetch failed' });
  });

  it('webhook: handles the stored event, marks it processed, and is a quiet done for it afterwards', async () => {
    const s = await setUpAwaiting();
    const eventId = 'WH-1';
    const payload = { id: eventId, event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: s.orderId } };
    await s.db.insert(webhookEvents).values({ eventId, eventType: 'CHECKOUT.ORDER.APPROVED', payload });
    await enqueue(s.db, 'webhook', { eventId }, NOW);

    await runAt(s, NOW);

    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
    expect(await s.db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents)).toEqual([{ processedAt: NOW }]);
    expect(await jobOf(s.db, 'webhook')).toMatchObject({ status: 'done' });

    const asked = s.paypal.calls.length;
    const handle = vi.spyOn(s.paypal, 'captureOrder');
    // Before the payout's first poll, so only the repeated webhook job is due.
    // One second on: the payout poll queued at 30 seconds is not due yet.
    await enqueue(s.db, 'webhook', { eventId }, after(1000));
    await runAt(s, after(1000));

    expect((await jobRows(s.db)).filter((job) => job.kind === 'webhook').map((job) => job.status)).toEqual(['done', 'done']);
    expect(handle).not.toHaveBeenCalled();
    expect(s.paypal.calls).toHaveLength(asked);
    expect(await s.db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents)).toEqual([{ processedAt: NOW }]);
  });

  it('webhook: runs again later for an event that is not stored', async () => {
    const s = await setUp('settled');
    await enqueue(s.db, 'webhook', { eventId: 'WH-MISSING' }, NOW);

    await runAt(s, NOW);

    expect(await jobOf(s.db, 'webhook')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'there is no stored PayPal webhook event WH-MISSING' });
  });

  it('webhook: leaves the event unprocessed when handling it fails, so the retry handles it', async () => {
    const s = await setUp('settled');
    const payload = { id: 'WH-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: {} };
    await s.db.insert(webhookEvents).values({ eventId: 'WH-2', eventType: 'CHECKOUT.ORDER.APPROVED', payload });
    await enqueue(s.db, 'webhook', { eventId: 'WH-2' }, NOW);

    await runAt(s, NOW);

    expect(await jobOf(s.db, 'webhook')).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await s.db.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents)).toEqual([{ processedAt: null }]);
  });

  it('charge_retry: replays a charge whose answer was never recorded, carrying the purchase on', async () => {
    const s = await setUp('proposed');
    s.paypal.failNext('chargeSavedWallet', 'lost_response');
    s.paypal.failNext('chargeSavedWallet', 'lost_response');
    await chargeAllowed(s.deps, s.purchaseId);
    expect(await statusOf(s.db, s.purchaseId)).toBe('charging');

    await runAt(s, after(2 * MINUTE));

    expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
    expect(s.paypal.captures).toHaveLength(1);
    expect(await jobOf(s.db, 'charge_retry')).toMatchObject({ status: 'done' });
  });

  it.each(['payout_poll', 'approval_expiry', 'charge_retry'] as const)('%s: runs again later, naming the problem, for a job with no purchase id', async (kind) => {
    const s = await setUp('settled');
    await enqueue(s.db, kind, {}, NOW);

    await runAt(s, NOW);

    expect(await jobOf(s.db, kind)).toMatchObject({ status: 'queued', attempts: 1, lastError: `a ${kind} job needs a purchaseId` });
  });
});
