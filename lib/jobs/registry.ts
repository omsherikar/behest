import type { JobHandlers } from './queue';
import type { JobRuntime } from './worker';

/**
 * The handlers the background worker runs and the dependencies they share. Each flow that
 * enqueues a job kind registers its handler here. Until a kind has one, the worker marks its
 * jobs dead with the kind named in `last_error`.
 */
export async function loadJobHandlers(): Promise<JobRuntime<undefined>> {
  // runDueJobs looks up each job's kind before dispatching, so a map missing kinds is safe.
  const handlers: Partial<JobHandlers<undefined>> = {};
  return { handlers: handlers as JobHandlers<undefined>, deps: undefined };
}
