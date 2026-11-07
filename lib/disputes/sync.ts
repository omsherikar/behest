import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes, purchases } from '@/lib/db/schema';
import type { DisputeDetail, DisputeSummary, PaypalPort } from '@/lib/paypal/port';
import { appendEvent, transition } from '@/lib/purchases/events';
import { canTransition } from '@/lib/purchases/transitions';

// Bringing the disputes buyers open at PayPal into Behest (architecture section 5.5). Each dispute is
// stored by PayPal's dispute id and matched to the purchase holding its capture. A matched purchase
// the lifecycle lets into a dispute moves to `disputed`, once, and on to `resolved` once PayPal closes
// the dispute leaving the money with Behest. A dispute the buyer wins moves no purchase here: PayPal
// returns the money with a refund or a reversal of the capture, whose webhook moves the purchase to
// `refunded`. The sync runs from a job, again and again, so it is idempotent: a later run updates
// what PayPal reports and moves nothing a second time. It writes only PayPal's side of a dispute and
// never the operator's: the evidence pack, the narrative and the submission time stay as they are.
// No database lock is held while PayPal is asked.

type SyncDeps = { db: Db; paypal: PaypalPort };

/** PayPal's status for a dispute it has closed. A closed dispute never opens one on its purchase. */
const CLOSED = 'RESOLVED';

/**
 * PayPal's outcome codes for a closed dispute that leaves the money with Behest: decided in the
 * seller's favour, or withdrawn by the buyer.
 */
const SELLER_KEEPS: ReadonlySet<string> = new Set(['RESOLVED_SELLER_FAVOUR', 'CANCELED_BY_BUYER']);

/**
 * Reads every dispute PayPal lists, each in full (the list leaves out the capture and the buyer's
 * notes), and stores it with storeDispute. Returns the number of disputes PayPal listed. A dispute
 * PayPal cannot read does not stop the rest: every other dispute is stored, then this throws naming
 * the ones that failed, so the job runs again. Throws at once if PayPal cannot list the disputes.
 */
export async function syncDisputes({ db, paypal }: SyncDeps): Promise<number> {
  const listed = await paypal.listDisputes();
  const failed: string[] = [];
  for (const summary of listed) {
    try {
      await storeDispute(db, withCapture(summary, await paypal.getDispute(summary.id)));
    } catch (error) {
      failed.push(`${summary.id} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (failed.length > 0) throw new Error(`could not sync PayPal disputes ${failed.join(', ')}`);
  return listed.length;
}

/** The dispute as read in full, with the listed capture if the full read named none. */
function withCapture(summary: DisputeSummary, detail: DisputeDetail): DisputeDetail {
  return { ...detail, captureId: detail.captureId ?? summary.captureId };
}

/**
 * In one transaction: stores the dispute, or updates the row already stored for it; links it to the
 * one purchase holding its capture, if it is not linked yet, logging `dispute_opened` on that
 * purchase; and moves the linked purchase to `disputed` while PayPal still has the dispute open and
 * the lifecycle (ALLOWED) allows the move, which today means a `settled` purchase. An `accepted`
 * purchase whose payout is still out is moved by a later sync, once the payout settles it. Once
 * PayPal has closed the dispute with an outcome that leaves the money with Behest, it logs
 * `dispute_resolved` and moves the purchase to `resolved` where ALLOWED allows it, which means a
 * `disputed` one; any other outcome moves nothing. The dispute row stays locked from the upsert to
 * the commit, so two syncs of one dispute take turns, and the purchase row is locked while its
 * status is read and moved.
 */
async function storeDispute(db: Db, dispute: DisputeDetail): Promise<void> {
  const reported = {
    status: dispute.status,
    reason: dispute.reason,
    amountCents: dispute.amountCents,
    openedAt: instant(dispute.createTime),
  };
  await db.transaction(async (tx) => {
    const [stored] = await tx
      .insert(disputes)
      .values({ paypalDisputeId: dispute.id, captureId: dispute.captureId, buyerNotes: dispute.buyerNotes, ...reported })
      .onConflictDoUpdate({
        target: disputes.paypalDisputeId,
        set: {
          ...reported,
          // A capture or notes PayPal once named are kept if a later read leaves them out.
          captureId: sql`coalesce(${disputes.captureId}, excluded.capture_id)`,
          buyerNotes: sql`coalesce(excluded.buyer_notes, ${disputes.buyerNotes})`,
        },
      })
      .returning({ id: disputes.id, purchaseId: disputes.purchaseId, captureId: disputes.captureId });

    const purchaseId = stored.purchaseId ?? (await link(tx, stored.id, stored.captureId, dispute));
    if (!purchaseId) return;

    const [purchase] = await tx
      .select({ status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (dispute.status !== CLOSED) {
      if (canTransition(purchase.status, 'disputed')) await transition(tx, purchaseId, purchase.status, 'disputed');
      return;
    }
    if (dispute.outcome !== null && SELLER_KEEPS.has(dispute.outcome) && canTransition(purchase.status, 'resolved')) {
      await appendEvent(tx, purchaseId, 'dispute_resolved', { paypalDisputeId: dispute.id, outcome: dispute.outcome });
      await transition(tx, purchaseId, purchase.status, 'resolved');
    }
  });
}

/**
 * Links the stored dispute to the purchase holding its capture and logs `dispute_opened` on it.
 * Returns the purchase's id, or null, linking nothing, when the dispute names no capture or the
 * capture is not held by exactly one purchase.
 */
async function link(tx: Db, disputeRowId: string, captureId: string | null, dispute: DisputeDetail): Promise<string | null> {
  if (!captureId) return null;
  const holders = await tx.select({ id: purchases.id }).from(purchases).where(eq(purchases.paypalCaptureId, captureId)).limit(2);
  if (holders.length !== 1) return null;
  const [{ id: purchaseId }] = holders;
  await tx.update(disputes).set({ purchaseId }).where(eq(disputes.id, disputeRowId));
  await appendEvent(tx, purchaseId, 'dispute_opened', { paypalDisputeId: dispute.id, reason: dispute.reason, status: dispute.status });
  return purchaseId;
}

/** The time PayPal gave, or null when it is not a readable time. */
function instant(time: string): Date | null {
  const at = new Date(time);
  return Number.isNaN(at.getTime()) ? null : at;
}
