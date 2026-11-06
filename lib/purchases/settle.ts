import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { payouts, purchases, sellers, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { PayPalApiError } from '@/lib/paypal/http';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import type { PurchaseDeps } from './deps';
import { appendEvent, StaleTransition, transition } from './events';

// Paying sellers. Behest is the merchant of record, so the buyer's payment lands in Behest's
// account; once the seller has verified the receipt and accepted the order, Behest pays the seller
// the order total with PayPal Payouts. The purchase settles when PayPal reports the payout item
// paid. The item, not the batch, decides, because the batch status trails the item's.
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

/** Statuses a purchase reaches only by settling. */
const SETTLED_OR_LATER: ReadonlySet<PurchaseStatus> = new Set(['settled', 'disputed', 'resolved']);

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
 * Follows a purchase's payout: the `payout_poll` job's handler. `done` once the purchase has settled,
 * once PayPal reports the item failed, or the batch denied or cancelled before it reported an item
 * (recorded on the payout and as a `payout_failed` event, with the purchase left `accepted`), or once
 * the purchase has moved on some other way, such as a refund. A payout that succeeds for a purchase
 * refunded while PayPal was asked is logged as a `payout_after_refund` event.
 * `retry` while the item is pending, unclaimed, on hold, missing or in a status not known here.
 * Throws, so the job is retried, if PayPal cannot be asked or has the payout but did not name its
 * batch; and, without asking PayPal, if the payout was never answered and is too old to resend safely.
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
  if (purchaseStatus !== 'accepted' || FAILED_STATUSES.has(payout.status)) return 'done';

  let payoutBatchId = payout.paypalBatchId;
  if (!payoutBatchId) {
    if (deps.now().getTime() - payout.createdAt.getTime() > RESEND_WINDOW_MS) {
      throw new Error(`payout ${payout.senderBatchId} is too old to resend safely; check PayPal before paying again`);
    }
    payoutBatchId = await sendPayout(deps, payout);
  }

  const { batchStatus, itemStatus } = await paypal.getPayoutBatch(payoutBatchId);
  // The item decides. A batch PayPal ended before reporting an item failed as a whole.
  const status = itemStatus ?? (FAILED_BATCH_STATUSES.has(batchStatus) ? batchStatus : null);
  if (status === null) return 'retry';
  const firstToRecord = await recordStatus(db, purchaseId, status, { payoutBatchId, batchStatus, itemStatus });
  if (FAILED_STATUSES.has(status)) return 'done';
  if (status !== 'SUCCESS') return 'retry';

  try {
    await transition(db, purchaseId, 'accepted', 'settled');
  } catch (error) {
    if (!(error instanceof StaleTransition)) throw error;
    // The purchase moved on while PayPal was asked. Unless an overlapping poll settled it, it was
    // refunded, and the seller has been paid for an order whose buyer got the money back. The poll
    // that first recorded the payout's success logs that, once.
    const [{ status: current }] = await db
      .select({ status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, purchaseId));
    if (firstToRecord && !SETTLED_OR_LATER.has(current)) {
      await appendEvent(db, purchaseId, 'payout_after_refund', { status: current });
    }
  }
  return 'done';
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
 * What an operator needs to tell a payout PayPal refused (a 4xx, such as missing funds or a bad
 * receiver) from one whose answer was lost: the message, the error's class and, when PayPal
 * answered, its HTTP status.
 */
function describeFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const answer = error instanceof PayPalApiError ? error : error.cause instanceof PayPalApiError ? error.cause : null;
  return { error: error.message, errorClass: error.name, ...(answer ? { httpStatus: answer.status } : {}) };
}

/**
 * Stores the payout's latest status, and returns whether this call changed it. The first time that
 * status is a failure, logs a `payout_failed` event with what PayPal reported, in the same
 * transaction, so overlapping polls log it once.
 */
async function recordStatus(
  db: Db,
  purchaseId: string,
  status: string,
  reported: { payoutBatchId: string; batchStatus: string; itemStatus: string | null },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = await tx
      .update(payouts)
      .set({ status })
      .where(and(eq(payouts.purchaseId, purchaseId), ne(payouts.status, status)))
      .returning({ id: payouts.id });
    if (changed.length > 0 && FAILED_STATUSES.has(status)) {
      await appendEvent(tx, purchaseId, 'payout_failed', reported);
    }
    return changed.length > 0;
  });
}
