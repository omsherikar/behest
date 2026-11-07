import { appDb, appPaypal, appSellerPort, appSigner } from '@/lib/app-deps';
import { type JobDeps, jobHandlers } from './handlers';
import { runPeriodicPass } from './periodic';
import type { JobRuntime } from './worker';

/**
 * What the background worker runs: a handler for every job kind, the periodic pass, and the live
 * dependencies they share, which are the app's database, PayPal, receipt signer and seller intake,
 * and the system clock. Throws when PayPal's credentials or the signing key are not set, so the worker
 * logs it and tries again on its next tick.
 */
export async function loadJobHandlers(): Promise<JobRuntime<JobDeps>> {
  const deps: JobDeps = {
    db: appDb(),
    paypal: appPaypal(),
    signer: await appSigner(),
    sellers: appSellerPort(),
    now: () => new Date(),
  };
  return { handlers: jobHandlers, deps, periodic: runPeriodicPass };
}
