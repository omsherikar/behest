import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { payouts, purchases, sellers } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
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
// call of payoutSeller sends the payout. PayPal refuses a sender batch id it has seen, so when the
// poll resends a payout whose answer was lost, the worst it can get is PayoutAlreadyExists naming
// the batch already sent.

type SettleDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'now'>;
type Payout = typeof payouts.$inferSelect;

/** Item statuses after which PayPal will not pay the seller. Settling then needs an operator. */
const FAILED_ITEM_STATUSES: ReadonlySet<string> = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED']);

/**
 * How long after sending a payout its first poll runs. PayPal usually pays a one-item batch within
 * seconds, and a poll sooner could race the payout request itself while it is still in flight.
 */
const FIRST_POLL_DELAY_MS = 30_000;

/**
 * Pays the seller of an accepted purchase its total, and queues a `payout_poll` job to follow the
 * payout. Only the first call sends anything. A purchase that has moved on from `accepted` with its
 * payout made is left alone; one that never reached `accepted` is refused. If PayPal's answer is
 * lost, the payout may or may not exist: that is logged as a `payout_unknown` event and left to the
 * poll, which sends it again under the same sender batch id.
 */
export async function payoutSeller(deps: SettleDeps, purchaseId: string): Promise<void> {
  const { db } = deps;
  const [purchase] = await db
    .select({ status: purchases.status, sellerId: purchases.sellerId, totalCents: purchases.totalCents })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
  if (purchase.status !== 'accepted') {
    if (await hasPayout(db, purchaseId)) return;
    throw new Error(`purchase ${purchaseId} is ${purchase.status}, and only an order its seller accepted is paid out`);
  }
  const { sellerId, totalCents } = purchase;
  if (!sellerId || totalCents === null) throw new Error(`accepted purchase ${purchaseId} has no seller or no total`);

  const payout = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(payouts)
      .values({ purchaseId, sellerId, amountCents: totalCents, senderBatchId: `${purchaseId}:payout` })
      .onConflictDoNothing({ target: payouts.purchaseId })
      .returning();
    if (row) await enqueue(tx, 'payout_poll', { purchaseId }, new Date(deps.now().getTime() + FIRST_POLL_DELAY_MS));
    return row;
  });
  // Another call got here first and is sending, or has sent, the payout.
  if (!payout) return;

  try {
    await sendPayout(deps, payout);
  } catch (error) {
    await appendEvent(db, purchaseId, 'payout_unknown', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Follows a purchase's payout: the `payout_poll` job's handler. `done` once the purchase has settled,
 * once PayPal reports the item failed (recorded on the payout and as a `payout_failed` event, with the
 * purchase left `accepted`), or once the purchase has moved on some other way, such as a refund.
 * `retry` while the item is pending, unclaimed, on hold, missing or in a status not known here.
 * Throws, to be retried, if PayPal has the payout but did not say which batch it is.
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
  if (purchaseStatus !== 'accepted' || FAILED_ITEM_STATUSES.has(payout.status)) return 'done';

  const payoutBatchId = payout.paypalBatchId ?? (await sendPayout(deps, payout));
  if (!payoutBatchId) {
    throw new Error(`PayPal has a payout under sender batch id ${payout.senderBatchId} but did not say which batch it is`);
  }

  const { batchStatus, itemStatus } = await paypal.getPayoutBatch(payoutBatchId);
  if (itemStatus === null) return 'retry';
  await recordItemStatus(db, purchaseId, { payoutBatchId, batchStatus, itemStatus });
  if (FAILED_ITEM_STATUSES.has(itemStatus)) return 'done';
  if (itemStatus !== 'SUCCESS') return 'retry';

  try {
    await transition(db, purchaseId, 'accepted', 'settled');
  } catch (error) {
    // The purchase moved on while PayPal was asked, settled by an overlapping poll or refunded.
    if (!(error instanceof StaleTransition)) throw error;
  }
  return 'done';
}

async function hasPayout(db: Db, purchaseId: string): Promise<boolean> {
  const rows = await db.select({ id: payouts.id }).from(payouts).where(eq(payouts.purchaseId, purchaseId));
  return rows.length > 0;
}

/**
 * Asks PayPal to make the payout and stores the batch PayPal names. A payout PayPal already has under
 * this sender batch id counts as sent. Returns the batch id, or null if PayPal has the payout but did
 * not say which batch it is.
 */
async function sendPayout({ db, paypal }: SettleDeps, payout: Payout): Promise<string | null> {
  const [seller] = await db.select({ payoutEmail: sellers.payoutEmail }).from(sellers).where(eq(sellers.id, payout.sellerId));
  let payoutBatchId: string | null;
  try {
    ({ payoutBatchId } = await paypal.createPayout({
      senderBatchId: payout.senderBatchId,
      receiverEmail: seller.payoutEmail,
      amountCents: payout.amountCents,
      note: `Behest order ${payout.purchaseId}`,
    }));
  } catch (error) {
    if (!(error instanceof PayoutAlreadyExists)) throw error;
    payoutBatchId = error.payoutBatchId;
  }
  if (payoutBatchId) await db.update(payouts).set({ paypalBatchId: payoutBatchId }).where(eq(payouts.id, payout.id));
  return payoutBatchId;
}

/**
 * Stores the item's latest status on the payout. The first time that status is a failure, logs a
 * `payout_failed` event in the same transaction, so overlapping polls log it once.
 */
async function recordItemStatus(
  db: Db,
  purchaseId: string,
  item: { payoutBatchId: string; batchStatus: string; itemStatus: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(payouts)
      .set({ status: item.itemStatus })
      .where(and(eq(payouts.purchaseId, purchaseId), ne(payouts.status, item.itemStatus)))
      .returning({ id: payouts.id });
    if (changed.length > 0 && FAILED_ITEM_STATUSES.has(item.itemStatus)) {
      await appendEvent(tx, purchaseId, 'payout_failed', item);
    }
  });
}
