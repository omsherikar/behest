import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type JobHandler, type JobHandlers, runDueJobs } from '@/lib/jobs/queue';
import { type JobRuntime, startWorker } from '@/lib/jobs/worker';

// The queue has its own tests against a real database. Here runDueJobs is a fake, and getDb()
// returns a stand-in, so these tests cover only when and how the worker calls it.
const appDb = vi.hoisted(() => ({ name: 'app database' }));
vi.mock('@/lib/db/client', () => ({ getDb: () => appDb }));
vi.mock('@/lib/jobs/queue', () => ({ runDueJobs: vi.fn(async () => 0) }));

const T = new Date('2026-11-06T12:00:00Z');
const after = (ms: number) => new Date(T.getTime() + ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Lets pending promise callbacks run. The fakes settle without timers, so one turn is enough. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const done: JobHandler<string> = async () => 'done';
const handlers: JobHandlers<string> = {
  payout_poll: done,
  approval_expiry: done,
  dispute_sync: done,
  webhook: done,
  charge_retry: done,
};
const runtime: JobRuntime<string> = { handlers, deps: 'deps' };

it('runs due jobs from the app database every interval with a clock that reads the current time', async () => {
  const getHandlers = vi.fn(async () => runtime);
  const stop = startWorker(getHandlers, 1000);

  vi.advanceTimersByTime(999);
  expect(getHandlers).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  await settle();
  vi.advanceTimersByTime(1000);
  await stop();

  const calls = vi.mocked(runDueJobs).mock.calls;
  expect(calls).toEqual([
    [appDb, handlers, 'deps', expect.any(Function)],
    [appDb, handlers, 'deps', expect.any(Function)],
  ]);
  const [, , , clock] = calls[0];
  expect(clock()).toEqual(after(2000));
  vi.setSystemTime(after(7000));
  expect(clock()).toEqual(after(7000));
  expect(getHandlers).toHaveBeenCalledOnce();
});

it('polls every 5 seconds by default', async () => {
  const stop = startWorker(async () => runtime);

  vi.advanceTimersByTime(4999);
  await settle();
  expect(runDueJobs).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  await stop();
  expect(runDueJobs).toHaveBeenCalledExactlyOnceWith(appDb, handlers, 'deps', expect.any(Function));
});

it('skips a tick that comes round while the previous one is still running', async () => {
  const slow = Promise.withResolvers<number>();
  vi.mocked(runDueJobs).mockReturnValueOnce(slow.promise);
  const stop = startWorker(async () => runtime, 1000);

  vi.advanceTimersByTime(1000);
  await settle();
  expect(runDueJobs).toHaveBeenCalledOnce();

  vi.advanceTimersByTime(1000);
  await settle();
  expect(runDueJobs).toHaveBeenCalledOnce();

  slow.resolve(1);
  await settle();
  vi.advanceTimersByTime(1000);
  await stop();
  expect(runDueJobs).toHaveBeenCalledTimes(2);
});

it('stops polling when told and waits for the tick in progress', async () => {
  const slow = Promise.withResolvers<number>();
  vi.mocked(runDueJobs).mockReturnValueOnce(slow.promise);
  const stop = startWorker(async () => runtime, 1000);
  vi.advanceTimersByTime(1000);
  await settle();

  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await settle();
  expect(stopped).toBe(false);

  slow.resolve(0);
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10_000);
  expect(runDueJobs).toHaveBeenCalledOnce();
});

it('logs a failed tick instead of throwing and loads the handlers again on the next tick', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const getHandlers = vi
    .fn<() => Promise<JobRuntime<string>>>()
    .mockRejectedValueOnce(new Error('RECEIPT_SIGNING_KEY is not set'))
    .mockResolvedValue(runtime);
  const stop = startWorker(getHandlers, 1000);

  vi.advanceTimersByTime(1000);
  await settle();
  expect(errorLog).toHaveBeenCalledExactlyOnceWith('Job worker tick failed: RECEIPT_SIGNING_KEY is not set');
  expect(runDueJobs).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1000);
  await stop();
  expect(getHandlers).toHaveBeenCalledTimes(2);
  expect(runDueJobs).toHaveBeenCalledExactlyOnceWith(appDb, handlers, 'deps', expect.any(Function));
});

it('keeps polling after running the jobs fails', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(runDueJobs).mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
  const stop = startWorker(async () => runtime, 1000);

  vi.advanceTimersByTime(1000);
  await settle();
  expect(errorLog).toHaveBeenCalledExactlyOnceWith('Job worker tick failed: connect ECONNREFUSED 127.0.0.1:5432');

  vi.advanceTimersByTime(1000);
  await stop();
  expect(runDueJobs).toHaveBeenCalledTimes(2);
});
