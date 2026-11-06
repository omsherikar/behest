import { and, asc, eq, inArray, lt, lte, or } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';

// A job queue kept in the `jobs` table. A worker claims the jobs that are due, runs each with the
// handler for its kind and records the outcome. Handlers must be idempotent, because a job runs
// again if its worker stops before recording the outcome.
//
// While a job is `running`, `run_at` holds the time this run claimed it, and from the moment its
// handler starts, the time it started. A job still running more than ten minutes after that is
// taken to belong to a worker that stopped mid-run, so it is due again. A run cut short that way
// does not count as an attempt.
//
// A handler gets five minutes by default. One still running then is abandoned, not stopped: its
// job counts as a retry and the run moves on, so a retry can start while the abandoned call is
// still going. Handlers must be safe to overlap with themselves, for example by reusing the same
// request ids.

export type JobKind = 'payout_poll' | 'approval_expiry' | 'dispute_sync' | 'webhook' | 'charge_retry';
export type JobPayload = Record<string, unknown>;
/** `done` finishes the job; `retry` runs it again after a backoff. A handler that throws counts as `retry`. */
export type JobOutcome = 'done' | 'retry';
export type JobHandler<D> = (payload: JobPayload, deps: D) => Promise<JobOutcome>;
export type JobHandlers<D> = Record<JobKind, JobHandler<D>>;
/** Reads the current time. The worker passes the real clock; tests pass a fixed or scripted one. */
export type Clock = () => Date;
export type RunOptions = {
  /**
   * How long a handler may run before its job counts as a retry. Defaults to five minutes. Keep it
   * under the ten minutes after which a running job looks abandoned to other workers.
   */
  handlerTimeoutMs?: number;
};

/** A job whose run fails this many times is marked dead and never runs again. */
const MAX_ATTEMPTS = 8;
/** How long after its claim, or its start once its turn comes, a running job is treated as abandoned. */
const ABANDONED_AFTER_MS = 10 * 60 * 1000;
/** The most jobs one runDueJobs call claims. The rest wait for the next call. */
const CLAIM_LIMIT = 5;
/** How long a handler may run, unless the caller says otherwise, before its job counts as a retry. */
const HANDLER_TIMEOUT_MS = 5 * 60 * 1000;

const BACKOFF_BASE_MS = 15 * 1000;
const BACKOFF_CAP_MS = 10 * 60 * 1000;
const ERROR_MESSAGE_LIMIT = 500;

/**
 * How long to wait before running a job again after a failed run, given `attempts`, the number of
 * runs that had failed before it: 15 seconds after the first failure, doubling up to 10 minutes.
 */
export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * BACKOFF_BASE_MS, BACKOFF_CAP_MS);
}

/** Adds a job and returns its id. Without `runAt` the job is due at once, by the database's clock. */
export async function enqueue(db: Db, kind: JobKind, payload: JobPayload, runAt?: Date): Promise<string> {
  const [job] = await db.insert(jobs).values({ kind, payload, runAt }).returning({ id: jobs.id });
  return job.id;
}

/**
 * Claims up to CLAIM_LIMIT due jobs, longest overdue first, runs each in turn with its kind's
 * handler and records the outcome. A kind missing from `handlers` marks its jobs dead. The clock
 * is read once for the claim, again as each job starts, and again when a retry is recorded.
 * Returns the number of jobs this call processed: those it claimed and still held when their turn
 * came.
 */
export async function runDueJobs<D>(
  db: Db,
  handlers: Partial<JobHandlers<D>>,
  deps: D,
  clock: Clock,
  { handlerTimeoutMs = HANDLER_TIMEOUT_MS }: RunOptions = {},
): Promise<number> {
  const claimedAt = clock();
  const claimed = await claimDueJobs(db, claimedAt);
  const run: Run<D> = { db, handlers, deps, clock, claimedAt, handlerTimeoutMs };
  let processed = 0;
  for (const job of claimed) {
    if (await runJob(run, job)) processed++;
  }
  return processed;
}

/** What every job in one runDueJobs call shares. */
type Run<D> = {
  db: Db;
  handlers: Partial<JobHandlers<D>>;
  deps: D;
  clock: Clock;
  claimedAt: Date;
  handlerTimeoutMs: number;
};

type ClaimedJob = { id: string; kind: string; payload: JobPayload; attempts: number };

/**
 * Marks the due jobs running in a single statement. Rows another transaction holds are skipped,
 * and a row claimed by a run that just committed no longer matches, so two workers polling at
 * once never claim the same job.
 */
function claimDueJobs(db: Db, now: Date): Promise<ClaimedJob[]> {
  const abandonedBefore = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(
        and(eq(jobs.status, 'queued'), lte(jobs.runAt, now)),
        and(eq(jobs.status, 'running'), lt(jobs.runAt, abandonedBefore)),
      ),
    )
    .orderBy(asc(jobs.runAt))
    .limit(CLAIM_LIMIT)
    .for('update', { skipLocked: true });
  return db
    .update(jobs)
    .set({ status: 'running', runAt: now })
    .where(inArray(jobs.id, due))
    .returning({ id: jobs.id, kind: jobs.kind, payload: jobs.payload, attempts: jobs.attempts });
}

/** Runs one claimed job. Returns false, without running it, if another run has taken it over. */
async function runJob<D>(
  { db, handlers, deps, clock, claimedAt, handlerTimeoutMs }: Run<D>,
  job: ClaimedJob,
): Promise<boolean> {
  // Renew the claim from this job's own start, so time spent waiting behind earlier jobs in the
  // batch does not count toward looking abandoned. If the claim from `claimedAt` is gone, another
  // run reclaimed the job while it waited, so leave it to that run.
  const startedAt = clock();
  const renewed = await db
    .update(jobs)
    .set({ runAt: startedAt })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.runAt, claimedAt)))
    .returning({ id: jobs.id });
  if (renewed.length === 0) return false;

  // Writes apply only while the job still holds this run's claim. If it was reclaimed as
  // abandoned in the meantime, the later run's outcome stands.
  const stillClaimed = and(eq(jobs.id, job.id), eq(jobs.status, 'running'), eq(jobs.runAt, startedAt));

  // `kind` is free text in the table, so look it up as an own key: `toString` is not a handler.
  const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind as JobKind] : undefined;
  if (!handler) {
    await db
      .update(jobs)
      .set({ status: 'dead', lastError: `no handler for job kind "${job.kind}"` })
      .where(stillClaimed);
    return true;
  }

  const { outcome, error } = await callHandler(() => handler(job.payload, deps), handlerTimeoutMs);
  if (outcome === 'done') {
    await db.update(jobs).set({ status: 'done' }).where(stillClaimed);
    return true;
  }

  // Back off from now, when the outcome is recorded, not from the start: a handler that ran out its
  // deadline or failed slowly must still wait out the full backoff before its next run.
  const attempts = job.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  await db
    .update(jobs)
    .set({
      attempts,
      status: dead ? 'dead' : 'queued',
      ...(dead ? {} : { runAt: new Date(clock().getTime() + backoffMs(job.attempts)) }),
      ...(error === undefined ? {} : { lastError: error }),
    })
    .where(stillClaimed);
  return true;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Calls a handler with a deadline. A throw counts as a retry with its message as the error. A call
 * still running at the deadline counts as a retry too; it is left to finish on its own, and
 * whatever it does then is ignored.
 */
async function callHandler(
  call: () => Promise<JobOutcome>,
  timeoutMs: number,
): Promise<{ outcome: JobOutcome; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const result = await Promise.race([call(), deadline]);
    if (result === TIMED_OUT) return { outcome: 'retry', error: `timed out after ${describeDuration(timeoutMs)}` };
    return { outcome: result };
  } catch (thrown) {
    return { outcome: 'retry', error: errorMessage(thrown) };
  } finally {
    clearTimeout(timer);
  }
}

/** A duration in its largest whole unit, such as "5 minutes" or "90 seconds". */
function describeDuration(ms: number): string {
  const [amount, unit] =
    ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : ms % 1000 === 0 ? [ms / 1000, 'second'] : [ms, 'millisecond'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/**
 * The thrown value's message, never its stack, cut to the first 500 characters. A value that
 * cannot be turned into text, such as an object without a prototype, gets a fixed message.
 */
function errorMessage(thrown: unknown): string {
  try {
    const message = thrown instanceof Error ? thrown.message || thrown.name : thrown;
    return String(message).slice(0, ERROR_MESSAGE_LIMIT);
  } catch {
    return 'handler failed with an unprintable error';
  }
}
