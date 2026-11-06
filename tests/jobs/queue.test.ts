import { eq } from 'drizzle-orm';
import { beforeAll, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import {
  backoffMs,
  enqueue,
  type JobHandler,
  type JobHandlers,
  type JobOutcome,
  runDueJobs,
} from '@/lib/jobs/queue';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 30_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const T = new Date('2026-11-06T12:00:00Z');
const after = (ms: number, from: Date = T) => new Date(from.getTime() + ms);

type Deps = { label: string };
const deps: Deps = { label: 'deps' };

/** A handler for every kind that finishes at once, with `overrides` replacing some of them. */
function handlersWith(overrides: Partial<JobHandlers<Deps>> = {}): JobHandlers<Deps> {
  const done: JobHandler<Deps> = async () => 'done';
  return {
    payout_poll: done,
    approval_expiry: done,
    dispute_sync: done,
    webhook: done,
    charge_retry: done,
    ...overrides,
  };
}

async function jobRow(db: Db, id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

/** A handler that signals once it starts and settles only when the test calls `finish`. */
function heldHandler() {
  const started = Promise.withResolvers<void>();
  const outcome = Promise.withResolvers<JobOutcome>();
  const handler: JobHandler<Deps> = () => {
    started.resolve();
    return outcome.promise;
  };
  return { handler, started: started.promise, finish: outcome.resolve };
}

it('stores a new job as queued with no attempts', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'payout_poll', { purchaseId: 'pur-1' }, after(MINUTE));
  expect(await jobRow(db, id)).toMatchObject({
    kind: 'payout_poll',
    payload: { purchaseId: 'pur-1' },
    status: 'queued',
    runAt: after(MINUTE),
    attempts: 0,
    lastError: null,
  });
});

it('makes a job due at once when no run time is given', async () => {
  const db = await createTestDb();
  const before = Date.now();
  const id = await enqueue(db, 'webhook', { eventId: 'WH-1' });
  const { runAt } = await jobRow(db, id);
  expect(runAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(runAt.getTime()).toBeLessThanOrEqual(Date.now());
});

it('runs a due job with its payload and deps, marks it done and never runs it again', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'payout_poll', { purchaseId: 'pur-1' }, T);
  const payoutPoll = vi.fn<JobHandler<Deps>>(async () => 'done');
  const handlers = handlersWith({ payout_poll: payoutPoll });

  expect(await runDueJobs(db, handlers, deps, T)).toBe(1);
  expect(payoutPoll).toHaveBeenCalledExactlyOnceWith({ purchaseId: 'pur-1' }, deps);
  expect(await jobRow(db, id)).toMatchObject({ status: 'done', attempts: 0, lastError: null });

  expect(await runDueJobs(db, handlers, deps, after(HOUR))).toBe(0);
  expect(payoutPoll).toHaveBeenCalledOnce();
});

it('sends each job to the handler for its kind', async () => {
  const db = await createTestDb();
  await enqueue(db, 'webhook', { eventId: 'WH-1' }, T);
  await enqueue(db, 'dispute_sync', { disputeId: 'PP-D-1' }, T);
  const webhook = vi.fn<JobHandler<Deps>>(async () => 'done');
  const disputeSync = vi.fn<JobHandler<Deps>>(async () => 'done');

  expect(await runDueJobs(db, handlersWith({ webhook, dispute_sync: disputeSync }), deps, T)).toBe(2);
  expect(webhook).toHaveBeenCalledExactlyOnceWith({ eventId: 'WH-1' }, deps);
  expect(disputeSync).toHaveBeenCalledExactlyOnceWith({ disputeId: 'PP-D-1' }, deps);
});

it('does not run a job before its run time', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'approval_expiry', { purchaseId: 'pur-1' }, after(MINUTE));
  const expire = vi.fn<JobHandler<Deps>>(async () => 'done');
  const handlers = handlersWith({ approval_expiry: expire });

  expect(await runDueJobs(db, handlers, deps, after(MINUTE - 1))).toBe(0);
  expect(expire).not.toHaveBeenCalled();
  expect(await jobRow(db, id)).toMatchObject({ status: 'queued', attempts: 0 });

  expect(await runDueJobs(db, handlers, deps, after(MINUTE))).toBe(1);
  expect(expire).toHaveBeenCalledOnce();
});

it('reschedules a job that asks to retry with backoff and counts the attempt', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'payout_poll', { purchaseId: 'pur-1' }, T);
  const payoutPoll = vi.fn<JobHandler<Deps>>(async () => 'retry');
  const handlers = handlersWith({ payout_poll: payoutPoll });

  expect(await runDueJobs(db, handlers, deps, T)).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({ status: 'queued', attempts: 1, runAt: after(15 * SECOND), lastError: null });

  expect(await runDueJobs(db, handlers, deps, after(15 * SECOND - 1))).toBe(0);
  const second = after(15 * SECOND);
  expect(await runDueJobs(db, handlers, deps, second)).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({ status: 'queued', attempts: 2, runAt: after(30 * SECOND, second) });
  expect(payoutPoll).toHaveBeenCalledTimes(2);
});

it('waits 15 seconds after the first failure and doubles the wait up to 10 minutes', () => {
  const waits = [0, 1, 2, 3, 4, 5, 6, 7, 12].map(backoffMs);
  expect(waits).toEqual([15, 30, 60, 120, 240, 480, 600, 600, 600].map((seconds) => seconds * SECOND));
});

it('marks a job dead on its eighth failure', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'dispute_sync', { disputeId: 'PP-D-1' }, T);
  const disputeSync = vi.fn<JobHandler<Deps>>(async () => 'retry');
  const handlers = handlersWith({ dispute_sync: disputeSync });

  let now = T;
  for (let failures = 1; failures <= 7; failures++) {
    expect(await runDueJobs(db, handlers, deps, now)).toBe(1);
    const row = await jobRow(db, id);
    expect(row).toMatchObject({ status: 'queued', attempts: failures });
    now = row.runAt;
  }

  expect(await runDueJobs(db, handlers, deps, now)).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({ status: 'dead', attempts: 8 });
  expect(disputeSync).toHaveBeenCalledTimes(8);

  expect(await runDueJobs(db, handlers, deps, after(24 * HOUR, now))).toBe(0);
  expect(disputeSync).toHaveBeenCalledTimes(8);
});

it('counts a throwing handler as a retry and stores its message', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'webhook', { eventId: 'WH-1' }, T);
  const webhook = vi.fn<JobHandler<Deps>>(async () => {
    throw new Error('PayPal returned 503 Service Unavailable');
  });

  expect(await runDueJobs(db, handlersWith({ webhook }), deps, T)).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({
    status: 'queued',
    attempts: 1,
    runAt: after(15 * SECOND),
    lastError: 'PayPal returned 503 Service Unavailable',
  });
});

it('stores only the first 500 characters of an error message and never the stack', async () => {
  const db = await createTestDb();
  const long = await enqueue(db, 'webhook', { eventId: 'WH-1' }, T);
  const thrownString = await enqueue(db, 'charge_retry', { purchaseId: 'pur-1' }, T);
  const handlers = handlersWith({
    webhook: async () => {
      throw new Error('x'.repeat(600));
    },
    charge_retry: async () => {
      throw 'socket hang up';
    },
  });

  expect(await runDueJobs(db, handlers, deps, T)).toBe(2);
  expect((await jobRow(db, long)).lastError).toBe('x'.repeat(500));
  expect((await jobRow(db, thrownString)).lastError).toBe('socket hang up');
});

it('stores a fixed message when the thrown value cannot be turned into text', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'webhook', { eventId: 'WH-1' }, T);
  const webhook: JobHandler<Deps> = async () => {
    // No prototype, so no toString or Symbol.toPrimitive: String() on it throws a TypeError.
    throw Object.create(null);
  };

  expect(await runDueJobs(db, handlersWith({ webhook }), deps, T)).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({
    status: 'queued',
    attempts: 1,
    lastError: 'handler failed with an unprintable error',
  });
});

it('marks a job dead when no handler is registered for its kind, and still runs the others', async () => {
  const db = await createTestDb();
  const unhandled = await enqueue(db, 'charge_retry', { purchaseId: 'pur-1' }, T);
  // A kind left in the table by older code. Inherited object keys must not count as handlers.
  const [{ id: legacy }] = await db
    .insert(jobs)
    .values({ kind: 'toString', payload: {}, runAt: T })
    .returning({ id: jobs.id });
  const handled = await enqueue(db, 'webhook', { eventId: 'WH-1' }, T);
  const webhook = vi.fn<JobHandler<Deps>>(async () => 'done');
  const handlers: Partial<JobHandlers<Deps>> = { webhook };

  expect(await runDueJobs(db, handlers, deps, T)).toBe(3);
  expect(await jobRow(db, unhandled)).toMatchObject({
    status: 'dead',
    attempts: 0,
    lastError: 'no handler for job kind "charge_retry"',
  });
  expect(await jobRow(db, legacy)).toMatchObject({ status: 'dead', lastError: 'no handler for job kind "toString"' });
  expect(await jobRow(db, handled)).toMatchObject({ status: 'done' });
  expect(webhook).toHaveBeenCalledOnce();
});

// PGlite runs one statement at a time, so this shows that the claim marks jobs running in the same
// statement that selects them. Two Postgres connections contending for rows, where FOR UPDATE SKIP
// LOCKED does its work, are not exercised here.
it('does not claim a job that another run has already claimed', async () => {
  const db = await createTestDb();
  for (const eventId of ['WH-1', 'WH-2', 'WH-3']) await enqueue(db, 'webhook', { eventId }, T);
  const webhook = vi.fn<JobHandler<Deps>>(async () => 'done');
  const handlers = handlersWith({ webhook });

  const [first, second] = await Promise.all([
    runDueJobs(db, handlers, deps, T),
    runDueJobs(db, handlers, deps, T),
  ]);

  expect(first + second).toBe(3);
  expect(webhook).toHaveBeenCalledTimes(3);
  expect(webhook.mock.calls.map(([payload]) => payload.eventId).sort()).toEqual(['WH-1', 'WH-2', 'WH-3']);
});

it('runs a job again once a stopped worker has left it running for over 10 minutes from its claim', async () => {
  const db = await createTestDb();
  // Overdue by an hour, so only the claim time can keep it from looking abandoned at once.
  const id = await enqueue(db, 'charge_retry', { purchaseId: 'pur-1' }, after(-HOUR));
  // This run claims the job at T and never finishes, like a worker whose process died.
  const stuck = heldHandler();
  void runDueJobs(db, handlersWith({ charge_retry: stuck.handler }), deps, T);
  await stuck.started;

  const chargeRetry = vi.fn<JobHandler<Deps>>(async () => 'done');
  const handlers = handlersWith({ charge_retry: chargeRetry });
  expect(await runDueJobs(db, handlers, deps, after(10 * MINUTE))).toBe(0);
  expect(chargeRetry).not.toHaveBeenCalled();

  expect(await runDueJobs(db, handlers, deps, after(10 * MINUTE + 1))).toBe(1);
  expect(chargeRetry).toHaveBeenCalledExactlyOnceWith({ purchaseId: 'pur-1' }, deps);
  expect(await jobRow(db, id)).toMatchObject({ status: 'done', attempts: 0 });
});

it('records only the outcome of the run that reclaimed a job, not of the abandoned run', async () => {
  const db = await createTestDb();
  const id = await enqueue(db, 'payout_poll', { purchaseId: 'pur-1' }, T);
  const abandoned = heldHandler();
  const abandonedRun = runDueJobs(db, handlersWith({ payout_poll: abandoned.handler }), deps, T);
  await abandoned.started;

  const reclaimed = heldHandler();
  const reclaimedRun = runDueJobs(db, handlersWith({ payout_poll: reclaimed.handler }), deps, after(11 * MINUTE));
  await reclaimed.started;

  abandoned.finish('retry');
  await abandonedRun;
  expect(await jobRow(db, id)).toMatchObject({ status: 'running', attempts: 0, runAt: after(11 * MINUTE) });

  reclaimed.finish('done');
  expect(await reclaimedRun).toBe(1);
  expect(await jobRow(db, id)).toMatchObject({ status: 'done', attempts: 0 });
});

it('claims at most 25 jobs per run, oldest first', async () => {
  const db = await createTestDb();
  const newest = await enqueue(db, 'webhook', { eventId: 'WH-new' }, T);
  for (let n = 0; n < 25; n++) await enqueue(db, 'webhook', { eventId: `WH-${n}` }, after(-MINUTE));

  expect(await runDueJobs(db, handlersWith(), deps, T)).toBe(25);
  expect(await jobRow(db, newest)).toMatchObject({ status: 'queued' });

  expect(await runDueJobs(db, handlersWith(), deps, T)).toBe(1);
  expect(await jobRow(db, newest)).toMatchObject({ status: 'done' });
});
