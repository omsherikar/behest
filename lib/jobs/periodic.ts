import { and, eq, exists, gt, inArray, isNotNull, isNull, lt, max, notExists, notInArray, or, type SQL, sql } from 'drizzle-orm';
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
// within a step, is isolated: one that fails is logged and the rest still run. Times on purchases
// and payouts are the app's clock; event times are the database's, and the two agree in production.

const MINUTE_MS = 60 * 1000;
/** How often PayPal's disputes are read, counted from the start of the last sync. */
const DISPUTE_SYNC_EVERY_MS = 10 * MINUTE_MS;
/** How long a purchase may stay `proposed` before it is taken as abandoned. */
const PROPOSAL_ABANDONED_AFTER_MS = 15 * MINUTE_MS;
/** How long after its capture, or its last unanswered delivery, an order is delivered again. */
const REDELIVER_AFTER_MS = 5 * MINUTE_MS;
/** How long after its last lost answer a refund is asked for again. */
const REFUND_RETRY_AFTER_MS = 5 * MINUTE_MS;

/** A job that has not finished, so another of the same kind and payload would only double it. */
const ACTIVE_JOB = ['queued', 'running'] as const;
/** What a seller says about an order. Any one of them means delivering it again would not help. */
const SELLER_ANSWERS = ['seller_accepted', 'seller_rejected', 'seller_ambiguous'];
/** Payout statuses with which PayPal holds the money for the seller to claim or for review. */
const UNCLAIMED = ['UNCLAIMED', 'ONHOLD'];

type Step = (deps: JobDeps, now: Date) => Promise<void>;

/**
 * Runs every step once, with the clock read once: keeps a dispute sync queued, queues the polls
 * of unfinished payouts, fails abandoned proposals, delivers unanswered orders again, retries lost
 * refunds and flags payouts left unclaimed after a refund. Never throws.
 */
export async function runPeriodicPass(deps: JobDeps): Promise<void> {
  const now = deps.now();
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
      await step(deps, now);
    } catch (error) {
      console.error(`Periodic pass step "${name}" failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Keeps one `dispute_sync` queued: when none is queued or running, queues the next one ten minutes
 * after the last one started, or now if that time has passed or none has ever run. A sync a webhook
 * queued counts, so it is not doubled.
 */
async function keepDisputeSyncQueued({ db }: JobDeps, now: Date): Promise<void> {
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
 * Queues a `payout_poll`, due now, for every payout PayPal has not finished whose purchase has no
 * poll queued or running, whatever the purchase's status: a payout can stay unclaimed for 30 days,
 * longer than one poll job's attempts last. A payout that never got a batch back is left out unless
 * its purchase is still `accepted`, since the poll would only refuse to send it again.
 */
async function queuePayoutPolls({ db }: JobDeps, now: Date): Promise<void> {
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
                inArray(jobs.status, [...ACTIVE_JOB]),
                sql`${jobs.payload}->>'purchaseId' = ${payouts.purchaseId}::text`,
              ),
            ),
        ),
      ),
    );
  for (const { purchaseId } of unfinished) await enqueue(db, 'payout_poll', { purchaseId }, now);
}

/**
 * Fails every purchase left `proposed` for more than 15 minutes, logging `proposal_abandoned`: its
 * proposal never reached a charge or an approval, so no money moved and its budget is released. The
 * lifecycle reaches `failed` only through `charging`, the way a charge refused before PayPal is
 * asked does. A purchase another call moves on first is left to that call.
 */
async function failAbandonedProposals({ db }: JobDeps, now: Date): Promise<void> {
  const abandoned = await db
    .select({ id: purchases.id, proposedAt: purchases.createdAt })
    .from(purchases)
    .where(and(eq(purchases.status, 'proposed'), lt(purchases.createdAt, new Date(now.getTime() - PROPOSAL_ABANDONED_AFTER_MS))));
  for (const { id, proposedAt } of abandoned) {
    await forEachPurchase('fail abandoned', id, async () => {
      try {
        await db.transaction(async (tx) => {
          await appendEvent(tx, id, 'proposal_abandoned', { proposedAt: proposedAt.toISOString() });
          await transition(tx, id, 'proposed', 'charging');
          await transition(tx, id, 'charging', 'failed');
        });
      } catch (error) {
        if (!(error instanceof StaleTransition)) throw error;
      }
    });
  }
}

/**
 * Delivers again every order captured more than 5 minutes ago that its seller has not answered:
 * no acceptance, rejection or ambiguous answer is logged, and no delivery left unanswered in the
 * last 5 minutes. The receipt is issued first, in case the capture was recorded but the receipt was
 * not. deliverToSeller treats a `replayed` or `expired` rejection as ambiguous and never refunds it,
 * since the seller may have accepted the first delivery and lost its answer.
 */
async function deliverUnansweredOrders(deps: JobDeps, now: Date): Promise<void> {
  const { db } = deps;
  const since = new Date(now.getTime() - REDELIVER_AFTER_MS);
  const unanswered = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(
      and(
        eq(purchases.status, 'captured'),
        lt(purchases.capturedAt, since),
        notExists(eventOf(db, inArray(purchaseEvents.kind, SELLER_ANSWERS))),
        notExists(eventOf(db, and(eq(purchaseEvents.kind, 'seller_unknown'), gt(purchaseEvents.createdAt, since)))),
      ),
    );
  for (const { id } of unanswered) {
    await forEachPurchase('deliver again', id, async () => {
      await issueReceipt(deps, id);
      await deliverToSeller(deps, id);
    });
  }
}

/**
 * Asks PayPal again for every refund of a rejected order whose last attempt lost its answer
 * (`refund_unknown`) at least 5 minutes ago, through retryLostRefund, which sends the first
 * attempt's request id, note and amount, so PayPal refunds at most once.
 */
async function retryLostRefunds(deps: JobDeps, now: Date): Promise<void> {
  const { db } = deps;
  const since = new Date(now.getTime() - REFUND_RETRY_AFTER_MS);
  const lost = await db
    .select({ id: purchases.id })
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
        notExists(eventOf(db, and(eq(purchaseEvents.kind, 'refund_unknown'), gt(purchaseEvents.createdAt, since)))),
      ),
    );
  for (const { id } of lost) await forEachPurchase('retry the refund of', id, () => retryLostRefund(deps, id));
}

/**
 * Logs `payout_unclaimed_after_refund` once for each refunded purchase whose seller payout PayPal
 * holds as UNCLAIMED or ONHOLD: the buyer has the money back while the seller's payout is still out,
 * which an operator may want to cancel. Checked again with the purchase locked, so it is logged once.
 */
async function flagUnclaimedAfterRefund({ db }: JobDeps): Promise<void> {
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
    );
  for (const { purchaseId, payoutStatus, paypalBatchId } of held) {
    await forEachPurchase('flag the unclaimed payout of', purchaseId, () =>
      db.transaction(async (tx) => {
        await tx.select({ id: purchases.id }).from(purchases).where(eq(purchases.id, purchaseId)).for('update');
        const [flagged] = await tx
          .select({ id: purchaseEvents.id })
          .from(purchaseEvents)
          .where(and(eq(purchaseEvents.purchaseId, purchaseId), eq(purchaseEvents.kind, 'payout_unclaimed_after_refund')))
          .limit(1);
        if (!flagged) await appendEvent(tx, purchaseId, 'payout_unclaimed_after_refund', { payoutStatus, paypalBatchId });
      }),
    );
  }
}

/** The purchase's events matching `condition`, for an exists check against the outer purchase row. */
function eventOf(db: Db, condition: SQL | undefined) {
  return db
    .select({ id: purchaseEvents.id })
    .from(purchaseEvents)
    .where(and(eq(purchaseEvents.purchaseId, purchases.id), condition));
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
