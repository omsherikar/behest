import { and, eq, ne, notInArray } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { payouts, purchases, sellers, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { PayPalApiError } from '@/lib/paypal/http';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import type { PurchaseDeps } from './deps';
import { appendEvent, transition } from './events';

// Paying sellers. Behest is the merchant of record, so the buyer's payment lands in Behest's
// account; once the seller has verified the receipt and accepted the order, Behest pays the seller
// the order total with PayPal Payouts. The purchase settles when PayPal reports the payout item
// paid. The item, not the batch, decides, because the batch status trails the item's. A payout is
// followed until PayPal finishes it, even if its purchase is refunded meanwhile, so that a seller
// paid for a refunded order is always on record.
//
// Both functions may run again, even while an earlier call is still going, and neither may pay
// twice. The payouts row, one per purchase, is written before PayPal is asked, so only the first
// call of payoutSeller sends the payout. PayPal refuses a sender batch id it has seen in the last 30
// days, so when the poll resends a payout whose answer was lost, the worst it can get is
// PayoutAlreadyExists naming the batch already sent. After 30 days PayPal would take the same sender
// batch id as a new payout and pay the seller again, so the poll never resends a payout more than 29
// days old.

type SettleDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'now'>;
type Payout = typeof payouts.$inferSelect;

/** Item statuses after which PayPal will not pay the seller. */
const FAILED_ITEM_STATUSES = ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'];
/** Batch statuses after which PayPal pays nothing. They decide only while the batch reports no item. */
const FAILED_BATCH_STATUSES: ReadonlySet<string> = new Set(['DENIED', 'CANCELED']);
/** Statuses, of the item or of a batch with no item, that leave the seller unpaid. Settling then needs an operator. */
const FAILED_STATUSES: ReadonlySet<string> = new Set([...FAILED_ITEM_STATUSES, ...FAILED_BATCH_STATUSES]);
/** Statuses that end a payout, paid or not. Once stored, a payout's status never changes again. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['SUCCESS', ...FAILED_STATUSES]);

/** The oldest payout the poll resends: a day inside the 30 days PayPal remembers a sender batch id. */
const RESEND_WINDOW_MS = 29 * 24 * 60 * 60 * 1000;

/**
 * How long after sending a payout its first poll runs. PayPal usually pays a one-item batch within
 * seconds, and a poll sooner could race the payout request itself while it is still in flight.
 */
const FIRST_POLL_DELAY_MS = 30_000;

/**
 * Pays the seller of an accepted purchase its total, and queues a `payout_poll` job to follow the
 * payout. Only the first call sends anything. A purchase refunded before its payout, or one that has
 * moved on from `accepted` with its payout made, is left alone; one that never reached `accepted` is
 * refused. If the payout cannot be followed, because PayPal's answer was lost, PayPal refused it, or
 * PayPal has it but did not name its batch, that is logged as a `payout_unknown` event and left to the
 * poll, which sends it again under the same sender batch id.
 */
export async function payoutSeller(deps: SettleDeps, purchaseId: string): Promise<void> {
  const { db } = deps;
  const payout = await db.transaction(async (tx) => {
    // Locked until the payout row is written, so a refund either lands first and stops the payout,
    // or waits and finds the payout row.
    const [purchase] = await tx
      .select({ status: purchases.status, sellerId: purchases.sellerId, totalCents: purchases.totalCents })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
    if (purchase.status !== 'accepted') {
      if (purchase.status === 'refunded' || (await hasPayout(tx, purchaseId))) return undefined;
      throw new Error(`purchase ${purchaseId} is ${purchase.status}, and only an order its seller accepted is paid out`);
    }
    const { sellerId, totalCents } = purchase;
    if (!sellerId || totalCents === null) throw new Error(`accepted purchase ${purchaseId} has no seller or no total`);

    const [row] = await tx
      .insert(payouts)
      .values({ purchaseId, sellerId, amountCents: totalCents, senderBatchId: `${purchaseId}:payout` })
      .onConflictDoNothing({ target: payouts.purchaseId })
      .returning();
    if (row) await enqueue(tx, 'payout_poll', { purchaseId }, new Date(deps.now().getTime() + FIRST_POLL_DELAY_MS));
    return row;
  });
  // Nothing to send: refunded first, or another call got here first and is sending, or has sent, it.
  if (!payout) return;

  try {
    await sendPayout(deps, payout);
  } catch (error) {
    await appendEvent(db, purchaseId, 'payout_unknown', describeFailure(error));
  }
}

/**
 * Follows a purchase's payout until PayPal finishes it: the `payout_poll` job's handler. It goes by
 * the payout, not the purchase, so it keeps asking PayPal after a refund. `done` once:
 * - the item is paid. An accepted purchase settles. A refunded one stays refunded, and the first
 *   poll to see the payment logs a `payout_after_refund` event;
 * - the item failed, or the batch was denied or cancelled before it reported an item. This is
 *   recorded on the payout and as a `payout_failed` event, and the purchase is left as it is.
 * `retry` while the item is pending, unclaimed, on hold, missing or in a status not known here.
 * Throws, so the job is retried, if PayPal cannot be asked or has the payout but did not name its
 * batch. Also throws, without asking PayPal, for a payout that never got a batch back if its purchase
 * is no longer accepted or it is too old to resend safely.
 */
export async function pollPayout(deps: SettleDeps, purchaseId: string): Promise<'done' | 'retry'> {
  const { db, paypal } = deps;
  const [found] = await db
    .select({ payout: payouts, purchaseStatus: purchases.status })
    .from(payouts)
    .innerJoin(purchases, eq(purchases.id, payouts.purchaseId))
    .where(eq(payouts.purchaseId, purchaseId));
  if (!found) throw new Error(`purchase ${purchaseId} has no payout to poll`);
  const { payout, purchaseStatus } = found;
  // Finished at PayPal: failed, or paid with nothing left to settle.
  if (FAILED_STATUSES.has(payout.status) || (payout.status === 'SUCCESS' && purchaseStatus !== 'accepted')) return 'done';

  const payoutBatchId = payout.paypalBatchId ?? (await resendPayout(deps, payout, purchaseStatus));

  const { batchStatus, itemStatus } = await paypal.getPayoutBatch(payoutBatchId);
  // The item decides. A batch PayPal ended before reporting an item failed as a whole.
  const status = itemStatus ?? (FAILED_BATCH_STATUSES.has(batchStatus) ? batchStatus : null);
  if (status === null) return 'retry';
  if (status === 'SUCCESS') {
    await recordSuccess(db, purchaseId);
    return 'done';
  }
  await recordStatus(db, purchaseId, status, { payoutBatchId, batchStatus, itemStatus });
  return FAILED_STATUSES.has(status) ? 'done' : 'retry';
}

/**
 * Sends again, under the same sender batch id, a payout whose first request brought back no batch.
 * Only while the purchase is accepted, so a refunded order is never paid out afresh, and only
 * within the window in which PayPal still refuses a repeated sender batch id.
 *
 * One window stays open by design. A refund that commits after the poll read `accepted` and before
 * this call reaches PayPal lets a payout PayPal never received go out for a refunded order. The poll
 * then records it as `payout_after_refund`. Closing the window would mean holding the purchase lock
 * across a network call.
 */
async function resendPayout(deps: SettleDeps, payout: Payout, purchaseStatus: PurchaseStatus): Promise<string> {
  if (purchaseStatus !== 'accepted') {
    throw new Error(
      `payout ${payout.senderBatchId} has no batch to follow and its purchase is ${purchaseStatus}, so it is not sent again; check PayPal`,
    );
  }
  if (deps.now().getTime() - payout.createdAt.getTime() > RESEND_WINDOW_MS) {
    throw new Error(`payout ${payout.senderBatchId} is too old to resend safely; check PayPal before paying again`);
  }
  return sendPayout(deps, payout);
}

async function hasPayout(db: Db, purchaseId: string): Promise<boolean> {
  const rows = await db.select({ id: payouts.id }).from(payouts).where(eq(payouts.purchaseId, purchaseId));
  return rows.length > 0;
}

/**
 * Asks PayPal to make the payout and stores and returns the batch PayPal names. A payout PayPal
 * already has under this sender batch id counts as sent; if PayPal does not name its batch, the
 * PayoutAlreadyExists is rethrown, since there is nothing to follow.
 */
async function sendPayout({ db, paypal }: SettleDeps, payout: Payout): Promise<string> {
  const [seller] = await db.select({ payoutEmail: sellers.payoutEmail }).from(sellers).where(eq(sellers.id, payout.sellerId));
  let payoutBatchId: string;
  try {
    ({ payoutBatchId } = await paypal.createPayout({
      senderBatchId: payout.senderBatchId,
      receiverEmail: seller.payoutEmail,
      amountCents: payout.amountCents,
      note: `Behest order ${payout.purchaseId}`,
    }));
  } catch (error) {
    if (!(error instanceof PayoutAlreadyExists) || error.payoutBatchId === null) throw error;
    payoutBatchId = error.payoutBatchId;
  }
  await db.update(payouts).set({ paypalBatchId: payoutBatchId }).where(eq(payouts.id, payout.id));
  return payoutBatchId;
}

/**
 * What an operator needs to tell a request PayPal refused (a 4xx, such as missing funds or a bad
 * receiver) from one whose answer was lost: the message, the error's class and, when PayPal
 * answered, its HTTP status.
 */
export function describeFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const answer = error instanceof PayPalApiError ? error : error.cause instanceof PayPalApiError ? error.cause : null;
  return { error: error.message, errorClass: error.name, ...(answer ? { httpStatus: answer.status } : {}) };
}

/** What PayPal reported about a payout's batch and its one item. */
type Reported = { payoutBatchId: string; batchStatus: string; itemStatus: string | null };

/**
 * Stores the payout's latest status, and returns whether this call changed it. A final status is
 * never replaced: a poll the queue abandoned can still write what PayPal told it earlier, after its
 * retry has stored how the payout ended. The update itself checks, so no read can go stale first.
 */
async function setPayoutStatus(db: Db, purchaseId: string, status: string): Promise<boolean> {
  const changed = await db
    .update(payouts)
    .set({ status })
    .where(
      and(eq(payouts.purchaseId, purchaseId), ne(payouts.status, status), notInArray(payouts.status, [...FINAL_STATUSES])),
    )
    .returning({ id: payouts.id });
  return changed.length > 0;
}

/**
 * Locks the purchase row for the rest of the transaction and returns its status. Every write here
 * that touches both rows takes the purchase first and the payout second, so two writers never
 * wait on each other in opposite orders.
 */
async function lockPurchase(tx: Db, purchaseId: string): Promise<PurchaseStatus> {
  const [{ status }] = await tx
    .select({ status: purchases.status })
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .for('update');
  return status;
}

/**
 * Stores a status other than SUCCESS. The first time it is a failure, logs a `payout_failed` event
 * with what PayPal reported, in the same transaction, so overlapping polls log it once.
 */
async function recordStatus(db: Db, purchaseId: string, status: string, reported: Reported): Promise<void> {
  await db.transaction(async (tx) => {
    await lockPurchase(tx, purchaseId);
    if ((await setPayoutStatus(tx, purchaseId, status)) && FAILED_STATUSES.has(status)) {
      await appendEvent(tx, purchaseId, 'payout_failed', reported);
    }
  });
}

/**
 * Stores a paid payout and, in the same transaction with the purchase locked, settles the purchase if
 * it is still accepted. If it was refunded, the seller has been paid for an order whose buyer got the
 * money back: the purchase stays refunded and, the first time the payout is seen paid, a
 * `payout_after_refund` event is logged, so overlapping polls log it once.
 */
async function recordSuccess(db: Db, purchaseId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const status = await lockPurchase(tx, purchaseId);
    const firstSeen = await setPayoutStatus(tx, purchaseId, 'SUCCESS');
    // Settle only when this call stored SUCCESS: a late answer from an abandoned run must not settle a
    // purchase whose payout is already recorded as failed.
    if (status === 'accepted' && firstSeen) await transition(tx, purchaseId, 'accepted', 'settled');
    else if (status === 'refunded' && firstSeen) await appendEvent(tx, purchaseId, 'payout_after_refund', { status });
  });
}
