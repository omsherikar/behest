import { and, asc, count, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, max, notExists, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchaseEvents, purchases, refunds } from '@/lib/db/schema';
import { deliverToSeller, retryLostRefund } from '@/lib/purchases/deliver';
import { appendEvent, StaleTransition, transition } from '@/lib/purchases/events';
import { issueReceipt } from '@/lib/purchases/receipt';
import { FINAL_STATUSES } from '@/lib/purchases/settle';
import type { JobDeps } from './handlers';
import { enqueue } from './queue';

// The worker's periodic pass, about once a minute: it keeps the follow-up work that no single event
// starts moving. Every step reads what needs doing from the database and acts on it, so it can run
// any number of times: a step that finds nothing to do changes nothing. Each step, and each purchase
// within a step, is isolated: one that fails is logged and the rest still run.
//
// A pass is bounded. Each step takes at most 10 rows, oldest first; anything left waits for the next
// pass. The steps that call the seller or PayPal stop once the pass has run a minute, so a slow
// outside service cannot hold the worker. Retries that never get an answer stop after 12 attempts,
// about an hour, and leave an event for an operator. Only one pass runs at a time, in this process
// and, on Postgres, across every worker.
//
// Times on purchases and payouts are the app's clock; event and job times are the database's, and
// the two agree in production.

const MINUTE_MS = 60 * 1000;
/** How often PayPal's disputes are read, counted from the start of the last sync. */
const DISPUTE_SYNC_EVERY_MS = 10 * MINUTE_MS;
/** How long after its last poll started an unfinished payout is polled again. */
const POLL_AGAIN_AFTER_MS = 60 * MINUTE_MS;
/** How long a purchase may stay `proposed` before it is taken as abandoned. */
const PROPOSAL_ABANDONED_AFTER_MS = 15 * MINUTE_MS;
/** How long after its capture, or its last unanswered delivery, an order is delivered again. */
const REDELIVER_AFTER_MS = 5 * MINUTE_MS;
/** How long after its last lost answer a refund is asked for again. */
const REFUND_RETRY_AFTER_MS = 5 * MINUTE_MS;
/** Unanswered deliveries, or lost refund answers, after which the pass stops and flags the purchase. */
const MAX_ATTEMPTS = 12;
/** The most rows one step takes in one pass. */
const ROWS_PER_STEP = 10;
/** How long a pass may run before the steps that call the seller or PayPal stop for that pass. */
const OUTSIDE_CALL_BUDGET_MS = 60 * 1000;
/** The Postgres advisory lock a pass holds while it runs, so two workers never run one at once. */
const PASS_LOCK_KEY = 4_242_001;

/** A job that has not finished, so another of the same kind and payload would only double it. */
const ACTIVE_JOB = ['queued', 'running'] as const;
/** What a seller says about an order. Any one of them means delivering it again would not help. */
const SELLER_ANSWERS = ['seller_accepted', 'seller_rejected', 'seller_ambiguous'];
/** Payout statuses with which PayPal holds the money for the seller to claim or for review. */
const UNCLAIMED = ['UNCLAIMED', 'ONHOLD'];

/** One pass: its dependencies, the time it started and when its outside calls must stop. */
type Pass = { deps: JobDeps; now: Date; callsUntil: number };
type Step = (pass: Pass) => Promise<void>;

/** Whether the pass has used its minute for calls to the seller or PayPal. */
const outOfTime = ({ deps, callsUntil }: Pass) => deps.now().getTime() >= callsUntil;

/** Whether a pass is running in this process. */
let passRunning = false;

/**
 * Runs every step once, with the clock read once for what is due: keeps a dispute sync queued,
 * queues the polls of unfinished payouts, fails abandoned proposals, delivers unanswered orders
 * again, retries lost refunds and flags payouts left unclaimed after a refund. A pass that starts
 * while another runs, in this process or, on Postgres, in another worker, does nothing. Never throws.
 */
export async function runPeriodicPass(deps: JobDeps): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    await withPassLock(deps.db, () => runSteps(deps));
  } catch (error) {
    console.error(`Periodic pass could not run: ${messageOf(error)}`);
  } finally {
    passRunning = false;
  }
}

async function runSteps(deps: JobDeps): Promise<void> {
  const now = deps.now();
  const pass: Pass = { deps, now, callsUntil: now.getTime() + OUTSIDE_CALL_BUDGET_MS };
  const steps: [string, Step][] = [
    ['dispute sync', keepDisputeSyncQueued],
    ['payout polls', queuePayoutPolls],
    ['abandoned proposals', failAbandonedProposals],
    ['undelivered orders', deliverUnansweredOrders],
    ['lost refunds', retryLostRefunds],
    ['payouts unclaimed after a refund', flagUnclaimedAfterRefund],
  ];
  for (const [name, step] of steps) {
    try {
      await step(pass);
    } catch (error) {
      console.error(`Periodic pass step "${name}" failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Runs `work` while holding the pass's advisory lock, or skips it when another worker holds the lock.
 * On Postgres the lock is a session lock, so it is taken, held and released on one client checked out
 * of the pool for the whole pass; a client whose unlock fails is closed rather than returned, which
 * releases the lock with its connection. PGlite has a single connection that only this process can
 * open, and that one session would take the lock again however often it asked, so there the guard in
 * runPeriodicPass is the only one needed.
 */
async function withPassLock(db: Db, work: () => Promise<void>): Promise<void> {
  // A node-postgres database exposes its pool as `$client`; a PGlite one, its PGlite instance.
  const pool = (db as unknown as { $client?: unknown }).$client;
  if (!(pool instanceof Pool)) {
    await work();
    return;
  }
  const client = await pool.connect();
  let closeClient = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [PASS_LOCK_KEY]);
    if (!rows[0]?.locked) return;
    try {
      await work();
    } finally {
      await client.query('select pg_advisory_unlock($1)', [PASS_LOCK_KEY]).catch((error: unknown) => {
        console.error(`Periodic pass could not release its lock, so its connection is closed: ${messageOf(error)}`);
        closeClient = true;
      });
    }
  } finally {
    client.release(closeClient);
  }
}

/**
 * Keeps one `dispute_sync` queued: when none is queued or running, queues the next one ten minutes
 * after the last one started, or now if that time has passed or none has ever run. A sync a webhook
 * queued counts, so it is not doubled.
 */
async function keepDisputeSyncQueued({ deps: { db }, now }: Pass): Promise<void> {
  const [active] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'dispute_sync'), inArray(jobs.status, [...ACTIVE_JOB])))
    .limit(1);
  if (active) return;
  const [{ lastRun }] = await db.select({ lastRun: max(jobs.runAt) }).from(jobs).where(eq(jobs.kind, 'dispute_sync'));
  const next = lastRun ? Math.max(now.getTime(), lastRun.getTime() + DISPUTE_SYNC_EVERY_MS) : now.getTime();
  await enqueue(db, 'dispute_sync', {}, new Date(next));
}

/**
 * Queues a `payout_poll`, due now, for each payout PayPal has not finished whose purchase has had no
 * poll queued, running or started in the last hour, whatever the purchase's status: a payout can stay
 * unclaimed for 30 days, longer than one poll job's attempts last, and an hour between rounds keeps a
 * payout that is simply unclaimed from leaving a dead job every half hour. A payout that never got a
 * batch back is left out unless its purchase is still `accepted`, since the poll would only refuse to
 * send it again. Each payout is queued on its own, so one that fails does not hold up the rest.
 */
async function queuePayoutPolls({ deps: { db }, now }: Pass): Promise<void> {
  const recentEnough = new Date(now.getTime() - POLL_AGAIN_AFTER_MS);
  const unfinished = await db
    .select({ purchaseId: payouts.purchaseId })
    .from(payouts)
    .innerJoin(purchases, eq(purchases.id, payouts.purchaseId))
    .where(
      and(
        notInArray(payouts.status, [...FINAL_STATUSES]),
        or(isNotNull(payouts.paypalBatchId), eq(purchases.status, 'accepted')),
        notExists(
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(
                eq(jobs.kind, 'payout_poll'),
                sql`${jobs.payload}->>'purchaseId' = ${payouts.purchaseId}::text`,
                or(inArray(jobs.status, [...ACTIVE_JOB]), gte(jobs.runAt, recentEnough)),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(payouts.createdAt))
    .limit(ROWS_PER_STEP);
  for (const { purchaseId } of unfinished) {
    await forEachPurchase('queue the payout poll of', purchaseId, () => enqueue(db, 'payout_poll', { purchaseId }, now));
  }
}

/**
 * Fails each purchase left `proposed` for more than 15 minutes, logging `proposal_abandoned`: its
 * proposal never reached a charge or an approval, so no money moved and its budget is released. A
 * purchase another call moves on first is left to that call.
 */
async function failAbandonedProposals({ deps: { db }, now }: Pass): Promise<void> {
  const abandoned = await db
    .select({ id: purchases.id, proposedAt: purchases.createdAt })
    .from(purchases)
    .where(and(eq(purchases.status, 'proposed'), lt(purchases.createdAt, new Date(now.getTime() - PROPOSAL_ABANDONED_AFTER_MS))))
    .orderBy(asc(purchases.createdAt))
    .limit(ROWS_PER_STEP);
  for (const { id, proposedAt } of abandoned) {
    await forEachPurchase('fail abandoned', id, async () => {
      try {
        await db.transaction(async (tx) => {
          await appendEvent(tx, id, 'proposal_abandoned', { proposedAt: proposedAt.toISOString() });
          await transition(tx, id, 'proposed', 'failed');
        });
      } catch (error) {
        if (!(error instanceof StaleTransition)) throw error;
      }
    });
  }
}

/**
 * Delivers again each order captured more than 5 minutes ago that its seller has not answered: no
 * acceptance, rejection or ambiguous answer is logged, and no delivery left unanswered in the last 5
 * minutes. The receipt is issued first, in case the capture was recorded but the receipt was not.
 * deliverToSeller treats a `replayed` or `expired` rejection as ambiguous and never refunds it, since
 * the seller may have accepted the first delivery and lost its answer. After 12 unanswered deliveries
 * the order is not delivered again: `seller_unreachable` is logged once for an operator.
 */
async function deliverUnansweredOrders(pass: Pass): Promise<void> {
  const { deps, now } = pass;
  const { db } = deps;
  const since = new Date(now.getTime() - REDELIVER_AFTER_MS);
  const unanswered = await db
    .select({ id: purchases.id, attempts: attemptsOf(db, 'seller_unknown') })
    .from(purchases)
    .where(
      and(
        eq(purchases.status, 'captured'),
        lt(purchases.capturedAt, since),
        notExists(eventOf(db, inArray(purchaseEvents.kind, [...SELLER_ANSWERS, 'seller_unreachable']))),
        notExists(eventOf(db, and(eq(purchaseEvents.kind, 'seller_unknown'), gt(purchaseEvents.createdAt, since)))),
      ),
    )
    .orderBy(asc(purchases.capturedAt))
    .limit(ROWS_PER_STEP);
  for (const { id, attempts } of unanswered) {
    if (attempts >= MAX_ATTEMPTS) {
      await forEachPurchase('flag the unreachable seller of', id, () => appendOnce(db, id, 'seller_unreachable', { attempts }));
      continue;
    }
    if (outOfTime(pass)) return;
    await forEachPurchase('deliver again', id, async () => {
      await issueReceipt(deps, id);
      await deliverToSeller(deps, id);
    });
  }
}

/**
 * Asks PayPal again for each refund of a rejected order whose last attempt lost its answer
 * (`refund_unknown`) at least 5 minutes ago, through retryLostRefund, which sends the first attempt's
 * request id, note and amount, so PayPal refunds at most once. After 12 lost answers it stops asking
 * and logs `refund_stuck` once for an operator.
 */
async function retryLostRefunds(pass: Pass): Promise<void> {
  const { deps, now } = pass;
  const { db } = deps;
  const since = new Date(now.getTime() - REFUND_RETRY_AFTER_MS);
  const lost = await db
    .select({ id: purchases.id, attempts: attemptsOf(db, 'refund_unknown') })
    .from(purchases)
    .where(
      and(
        eq(purchases.status, 'captured'),
        exists(
          db
            .select({ id: refunds.id })
            .from(refunds)
            .where(and(eq(refunds.purchaseId, purchases.id), isNull(refunds.paypalRefundId))),
        ),
        exists(eventOf(db, eq(purchaseEvents.kind, 'refund_unknown'))),
        notExists(eventOf(db, eq(purchaseEvents.kind, 'refund_stuck'))),
        notExists(eventOf(db, and(eq(purchaseEvents.kind, 'refund_unknown'), gt(purchaseEvents.createdAt, since)))),
      ),
    )
    .orderBy(asc(purchases.capturedAt))
    .limit(ROWS_PER_STEP);
  for (const { id, attempts } of lost) {
    if (attempts >= MAX_ATTEMPTS) {
      await forEachPurchase('flag the stuck refund of', id, () => appendOnce(db, id, 'refund_stuck', { attempts }));
      continue;
    }
    if (outOfTime(pass)) return;
    await forEachPurchase('retry the refund of', id, () => retryLostRefund(deps, id));
  }
}

/**
 * Logs `payout_unclaimed_after_refund` once for each refunded purchase whose seller payout PayPal
 * holds as UNCLAIMED or ONHOLD: the buyer has the money back while the seller's payout is still out,
 * which an operator may want to cancel.
 */
async function flagUnclaimedAfterRefund({ deps: { db } }: Pass): Promise<void> {
  const held = await db
    .select({ purchaseId: payouts.purchaseId, payoutStatus: payouts.status, paypalBatchId: payouts.paypalBatchId })
    .from(payouts)
    .innerJoin(purchases, eq(purchases.id, payouts.purchaseId))
    .where(
      and(
        eq(purchases.status, 'refunded'),
        inArray(payouts.status, UNCLAIMED),
        notExists(eventOf(db, eq(purchaseEvents.kind, 'payout_unclaimed_after_refund'))),
      ),
    )
    .orderBy(asc(payouts.createdAt))
    .limit(ROWS_PER_STEP);
  for (const { purchaseId, payoutStatus, paypalBatchId } of held) {
    await forEachPurchase('flag the unclaimed payout of', purchaseId, () =>
      appendOnce(db, purchaseId, 'payout_unclaimed_after_refund', { payoutStatus, paypalBatchId }),
    );
  }
}

/** Appends a `kind` event to the purchase unless it has one, checked with the purchase row locked. */
async function appendOnce(db: Db, purchaseId: string, kind: string, data: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: purchases.id }).from(purchases).where(eq(purchases.id, purchaseId)).for('update');
    const [logged] = await tx
      .select({ id: purchaseEvents.id })
      .from(purchaseEvents)
      .where(and(eq(purchaseEvents.purchaseId, purchaseId), eq(purchaseEvents.kind, kind)))
      .limit(1);
    if (!logged) await appendEvent(tx, purchaseId, kind, data);
  });
}

/** The purchase's events matching `condition`, for an exists check against the outer purchase row. */
function eventOf(db: Db, condition: SQL | undefined) {
  return db
    .select({ id: purchaseEvents.id })
    .from(purchaseEvents)
    .where(and(eq(purchaseEvents.purchaseId, purchases.id), condition));
}

/** How many `kind` events the outer purchase row has: its failed attempts so far. */
function attemptsOf(db: Db, kind: string) {
  return sql<number>`(${db
    .select({ n: count() })
    .from(purchaseEvents)
    .where(and(eq(purchaseEvents.purchaseId, purchases.id), eq(purchaseEvents.kind, kind)))})`.mapWith(Number);
}

/** Runs one purchase's part of a step, logging a failure so the step goes on to the next purchase. */
async function forEachPurchase(action: string, purchaseId: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`Periodic pass could not ${action} purchase ${purchaseId}: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
