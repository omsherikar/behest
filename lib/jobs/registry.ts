import type { JobRuntime } from './worker';

/**
 * The handlers the background worker runs and the dependencies they share. Each flow that
 * enqueues a job kind registers its handler here. Until a kind has one, the worker marks its
 * jobs dead with the kind named in `last_error`.
 */
export async function loadJobHandlers(): Promise<JobRuntime<undefined>> {
  return { handlers: {}, deps: undefined };
}
