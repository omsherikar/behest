import { getDb } from '@/lib/db/client';
import { type JobHandlers, runDueJobs } from './queue';

/** What the worker runs jobs with: the handlers by kind and the dependencies passed to every handler. */
export type JobRuntime<D> = { handlers: Partial<JobHandlers<D>>; deps: D };

/**
 * Runs due jobs from the app database every `intervalMs`, with the real clock. A tick that comes
 * round while the previous one is still running is skipped, so ticks never overlap. A failed tick
 * is logged rather than thrown, so it cannot take the server down.
 *
 * `getHandlers` is called on the first tick and its result reused; if it fails, the next tick
 * calls it again. Returns a function that stops the worker and resolves once any tick in
 * progress has finished.
 */
export function startWorker<D>(getHandlers: () => Promise<JobRuntime<D>>, intervalMs = 5000): () => Promise<void> {
  let runtime: Promise<JobRuntime<D>> | undefined;
  let tickInProgress: Promise<void> | undefined;

  async function tick(): Promise<void> {
    try {
      runtime ??= getHandlers().catch((error: unknown) => {
        runtime = undefined;
        throw error;
      });
      const { handlers, deps } = await runtime;
      await runDueJobs(getDb(), handlers, deps, () => new Date());
    } catch (error) {
      console.error(`Job worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const timer = setInterval(() => {
    if (tickInProgress) return;
    tickInProgress = tick().finally(() => {
      tickInProgress = undefined;
    });
  }, intervalMs);

  return async () => {
    clearInterval(timer);
    await tickInProgress;
  };
}
