import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';
import { enqueue, type JobHandler, type JobHandlers } from '@/lib/jobs/queue';
import { type JobRuntime, startWorker } from '@/lib/jobs/worker';
import { createTestDb } from '@/tests/helpers/test-db';

// The worker reads the app database through getDb(); here that is each test's own database.
const app = vi.hoisted(() => ({ db: undefined as Db | undefined }));
vi.mock('@/lib/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/client')>()),
  getDb: () => app.db,
}));

// Only the worker's interval is faked. The worker reads the real clock, so jobs here are overdue.
beforeEach(async () => {
  app.db = await createTestDb();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const anHourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

/** Lets pending promise callbacks run without advancing any clock. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function runtimeWith(overrides: Partial<JobHandlers<null>> = {}): JobRuntime<null> {
  const done: JobHandler<null> = async () => 'done';
  const handlers: JobHandlers<null> = {
    payout_poll: done,
    approval_expiry: done,
    dispute_sync: done,
    webhook: done,
    charge_retry: done,
    ...overrides,
  };
  return { handlers, deps: null };
}

async function statusOf(id: string) {
  const [row] = await app.db!.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
  return row.status;
}

it('runs due jobs every interval and stops when told, after the tick in progress', async () => {
  const id = await enqueue(app.db!, 'webhook', { eventId: 'WH-1' }, anHourAgo());
  const webhook = vi.fn<JobHandler<null>>(async () => 'done');
  const getHandlers = vi.fn(async () => runtimeWith({ webhook }));
  const stop = startWorker(getHandlers, 1000);

  vi.advanceTimersByTime(999);
  expect(getHandlers).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  await stop();

  expect(webhook).toHaveBeenCalledExactlyOnceWith({ eventId: 'WH-1' }, null);
  expect(await statusOf(id)).toBe('done');
  expect(vi.getTimerCount()).toBe(0);
});

it('polls every 5 seconds by default', async () => {
  const getHandlers = vi.fn(async () => runtimeWith());
  const stop = startWorker(getHandlers);

  vi.advanceTimersByTime(4999);
  expect(getHandlers).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(getHandlers).toHaveBeenCalledOnce();
  await stop();
});

it('skips a tick that comes round while the previous one is still running', async () => {
  const first = await enqueue(app.db!, 'payout_poll', { purchaseId: 'pur-1' }, anHourAgo());
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<'done'>();
  const payoutPoll = vi.fn<JobHandler<null>>(() => {
    started.resolve();
    return release.promise;
  });
  const stop = startWorker(async () => runtimeWith({ payout_poll: payoutPoll }), 1000);

  vi.advanceTimersByTime(1000);
  await started.promise;
  const second = await enqueue(app.db!, 'payout_poll', { purchaseId: 'pur-2' }, anHourAgo());
  vi.advanceTimersByTime(1000);
  release.resolve('done');
  await stop();

  expect(payoutPoll).toHaveBeenCalledExactlyOnceWith({ purchaseId: 'pur-1' }, null);
  expect(await statusOf(first)).toBe('done');
  expect(await statusOf(second)).toBe('queued');
});

it('logs a failed tick instead of throwing and loads the handlers again on the next tick', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const id = await enqueue(app.db!, 'webhook', { eventId: 'WH-1' }, anHourAgo());
  const getHandlers = vi
    .fn<() => Promise<JobRuntime<null>>>()
    .mockRejectedValueOnce(new Error('RECEIPT_SIGNING_KEY is not set'))
    .mockResolvedValue(runtimeWith());
  const stop = startWorker(getHandlers, 1000);

  vi.advanceTimersByTime(1000);
  await settle();
  expect(errorLog).toHaveBeenCalledExactlyOnceWith('Job worker tick failed: RECEIPT_SIGNING_KEY is not set');
  expect(await statusOf(id)).toBe('queued');

  vi.advanceTimersByTime(1000);
  await stop();
  expect(getHandlers).toHaveBeenCalledTimes(2);
  expect(await statusOf(id)).toBe('done');
});
