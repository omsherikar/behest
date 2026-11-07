import { getDb } from '@/lib/db/client';
import { type JobHandlers, runDueJobs } from './queue';

/**
 * What the worker runs jobs with: the handlers by kind, the dependencies passed to every handler and,
 * optionally, a periodic pass that queues and repairs work no single event starts.
 */
export type JobRuntime<D> = { handlers: Partial<JobHandlers<D>>; deps: D; periodic?: (deps: D) => Promise<void> };

/** The periodic pass runs on the first tick, then on the first tick at least this long after it last started. */
const PERIODIC_PASS_EVERY_MS = 60_000;

/**
 * Runs due jobs from the app database every `intervalMs`, with the real clock. A tick that comes
 * round while the previous one is still running is skipped, so ticks never overlap. A failed tick
 * is logged rather than thrown, so it cannot take the server down.
 *
 * `getHandlers` is called on the first tick and its result reused; if it fails, the next tick
 * calls it again. A runtime with a periodic pass runs it before the due jobs on the first tick and
 * then about once a minute; a failed pass is logged and the due jobs still run. Returns a function that stops the worker and resolves once any tick in
 * progress has finished.
 */
export function startWorker<D>(getHandlers: () => Promise<JobRuntime<D>>, intervalMs = 5000): () => Promise<void> {
  let runtime: Promise<JobRuntime<D>> | undefined;
  let tickInProgress: Promise<void> | undefined;
  let lastPassAt: number | undefined;

  async function tick(): Promise<void> {
    try {
      runtime ??= getHandlers().catch((error: unknown) => {
        runtime = undefined;
        throw error;
      });
      const { handlers, deps, periodic } = await runtime;
      if (periodic && (lastPassAt === undefined || Date.now() - lastPassAt >= PERIODIC_PASS_EVERY_MS)) {
        lastPassAt = Date.now();
        await periodic(deps).catch((error: unknown) => {
          console.error(`Periodic job pass failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
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
