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

export type JobKind = 'payout_poll' | 'approval_expiry' | 'dispute_sync' | 'webhook' | 'charge_retry';
export type JobPayload = Record<string, unknown>;
/** `done` finishes the job; `retry` runs it again after a backoff. A handler that throws counts as `retry`. */
export type JobOutcome = 'done' | 'retry';
export type JobHandler<D> = (payload: JobPayload, deps: D) => Promise<JobOutcome>;
export type JobHandlers<D> = Record<JobKind, JobHandler<D>>;
/** Reads the current time. The worker passes the real clock; tests pass a fixed or scripted one. */
export type Clock = () => Date;

/** A job whose run fails this many times is marked dead and never runs again. */
const MAX_ATTEMPTS = 8;
/** How long after its claim a running job is treated as abandoned by a worker that stopped. */
const ABANDONED_AFTER_MS = 10 * 60 * 1000;
/** The most jobs one runDueJobs call claims. The rest wait for the next call. */
const CLAIM_LIMIT = 25;

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
 * is read once for the claim and again as each job starts. Returns the number of jobs this call
 * processed: those it claimed and still held when their turn came.
 */
export async function runDueJobs<D>(
  db: Db,
  handlers: Partial<JobHandlers<D>>,
  deps: D,
  clock: Clock,
): Promise<number> {
  const claimedAt = clock();
  const claimed = await claimDueJobs(db, claimedAt);
  let processed = 0;
  for (const job of claimed) {
    if (await runJob(db, job, handlers, deps, claimedAt, clock)) processed++;
  }
  return processed;
}

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
  db: Db,
  job: ClaimedJob,
  handlers: Partial<JobHandlers<D>>,
  deps: D,
  claimedAt: Date,
  clock: Clock,
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

  let outcome: JobOutcome;
  let error: string | undefined;
  try {
    outcome = await handler(job.payload, deps);
  } catch (thrown) {
    outcome = 'retry';
    error = errorMessage(thrown);
  }

  if (outcome === 'done') {
    await db.update(jobs).set({ status: 'done' }).where(stillClaimed);
    return true;
  }

  const attempts = job.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  await db
    .update(jobs)
    .set({
      attempts,
      status: dead ? 'dead' : 'queued',
      ...(dead ? {} : { runAt: new Date(startedAt.getTime() + backoffMs(job.attempts)) }),
      ...(error === undefined ? {} : { lastError: error }),
    })
    .where(stillClaimed);
  return true;
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
