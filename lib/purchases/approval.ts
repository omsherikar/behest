import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { purchases } from '@/lib/db/schema';
import { enqueue, type JobOutcome } from '@/lib/jobs/queue';
import type { PaypalPort } from '@/lib/paypal/port';
import { purchaseOutcome, recordCharge, takePayment, type PaymentRequest } from './charge';
import type { ProposalOutcome, PurchaseDeps } from './deps';
import { appendEvent, StaleTransition, transition } from './events';
import { receiptBlocker } from './receipt';
import { describeFailure } from './settle';

// Purchases the buyer approves themselves (architecture section 6.3). The gate sent the purchase to
// its buyer, so Behest creates a PayPal order and the buyer approves it on PayPal: that approval is
// PayPal's evidence that a human was present. Behest then captures the order, with the same safety
// as a saved-wallet charge (see charge.ts), and issues the receipt, delivers the order and pays the
// seller exactly as for an allowed purchase. An order left unapproved for three hours is cancelled,
// which releases its budget. No database lock is held while PayPal is asked.

type ApprovalDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'appUrl' | 'now'>;
type CaptureDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'signer' | 'sellers' | 'now'>;
type ApprovalRequest = Parameters<PaypalPort['createApprovalOrder']>[0];
type ApprovalOrder = Awaited<ReturnType<PaypalPort['createApprovalOrder']>>;
/** An `approval_order` event's data: the order PayPal created, and when its approval window closes. */
type RecordedOrder = { requestId: string; orderId: string; approveUrl: string; expiresAt: string };

/** How long the buyer has to approve a purchase before it is cancelled and its budget released. */
const APPROVAL_WINDOW_MS = 3 * 60 * 60 * 1000;

/** What the first failed attempt to create an approval order is logged under. The second is logged on the purchase. */
const FIRST_ATTEMPT_FAILED = 'Creating an approval order failed, so PayPal is asked again:';

/**
 * Sends a purchase the gate referred to its buyer to PayPal for their approval. Moves it from
 * `proposed` to `awaiting_approval` and queues its `approval_expiry` job in one transaction, then
 * asks PayPal for the order the buyer approves, asking once more with the same request id if that
 * throws, and stores the order's id and approval link on the purchase. Creating the order moves no
 * money, so if PayPal cannot answer either time the purchase is cancelled at once, releasing its
 * budget: no buyer can approve an order whose link they never saw. A purchase that could not be
 * given its receipt once captured fails with a `charge_refused` event, and PayPal is never asked.
 * A purchase another call has already moved on from `proposed` is returned as it stands. Throws,
 * changing nothing, for a purchase whose final verdict is not ASK.
 */
export async function startApproval(deps: ApprovalDeps, purchaseId: string): Promise<ProposalOutcome> {
  const { db } = deps;
  const [purchase] = await db
    .select({ finalVerdict: purchases.finalVerdict, totalCents: purchases.totalCents })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
  if (purchase.finalVerdict !== 'ASK') {
    throw new Error(
      `purchase ${purchaseId} has the final verdict ${purchase.finalVerdict}, and only a purchase sent to its buyer is approved at PayPal`,
    );
  }
  if (purchase.totalCents === null) throw new Error(`purchase ${purchaseId} sent to its buyer has no total`);

  const opened = await openApproval(deps, purchaseId, purchase.totalCents);
  if (!opened) return purchaseOutcome(db, purchaseId);
  const { request, expiresAt } = opened;

  let order: ApprovalOrder;
  try {
    order = await sendApprovalOrder(deps.paypal, purchaseId, request);
  } catch (error) {
    await cancelUnsentApproval(db, purchaseId, request.requestId, error);
    return purchaseOutcome(db, purchaseId);
  }
  const { orderId, approveUrl } = order;
  await storeApprovalOrder(db, purchaseId, { requestId: request.requestId, orderId, approveUrl, expiresAt: expiresAt.toISOString() });
  return purchaseOutcome(db, purchaseId);
}

/**
 * Captures the order of a purchase its buyer approved at PayPal and carries the purchase on to its
 * receipt, delivery and payout as for an allowed purchase. Both the buyer's return from PayPal and
 * PayPal's approval webhook call it, so it may run twice, even at once, and still captures once.
 * With the purchase locked, it moves it from `awaiting_approval` to `charging` with the buyer as
 * its approver, logs the capture request as a `charge` event and queues the `charge_retry` job that
 * replays it, all in one transaction. Only the call that made that move asks PayPal, through
 * takePayment, which also sends the purchase back to `awaiting_approval` if the buyer has not in
 * fact approved the order. Any other purchase, one already past `awaiting_approval` or cancelled,
 * is returned as it stands and nothing is called. Throws for an order no purchase was sent with.
 */
export async function completeApproval(deps: CaptureDeps, orderId: string): Promise<ProposalOutcome> {
  const { db } = deps;
  const [purchase] = await db.select({ id: purchases.id }).from(purchases).where(eq(purchases.paypalOrderId, orderId));
  if (!purchase) throw new Error(`there is no purchase with PayPal order ${orderId}`);

  const request = await enterCharging(deps, purchase.id, orderId);
  if (!request) return purchaseOutcome(db, purchase.id);
  return takePayment(deps, purchase.id, request);
}

/**
 * Cancels a purchase its buyer has not approved in time, releasing its budget: the handler of the
 * `approval_expiry` job queued with every approval, and again whenever PayPal sends a purchase back
 * for approval. With the purchase locked, it moves it from `awaiting_approval` to `cancelled` and
 * logs `approval_expired`, so of an expiry and an approval that race exactly one moves the purchase,
 * and a cancelled purchase is never captured. A purchase in any other status is left as it is.
 * Always `done`; throws for a purchase that does not exist.
 */
export async function expireApproval({ db }: Pick<PurchaseDeps, 'db'>, purchaseId: string): Promise<JobOutcome> {
  return db.transaction(async (tx): Promise<JobOutcome> => {
    const [purchase] = await tx
      .select({ status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
    if (purchase.status !== 'awaiting_approval') return 'done';
    await appendEvent(tx, purchaseId, 'approval_expired', {});
    await transition(tx, purchaseId, 'awaiting_approval', 'cancelled');
    return 'done';
  });
}

/**
 * Moves the purchase from `proposed` to `awaiting_approval` and queues its `approval_expiry` job,
 * and returns the order to ask PayPal for and when the approval window closes. If the purchase
 * could not be given its receipt, it fails the purchase instead, through `charging` as a refused
 * charge does, and returns null; it also returns null for a purchase another call has already
 * moved on.
 */
async function openApproval(
  { db, appUrl, now }: ApprovalDeps,
  purchaseId: string,
  totalCents: number,
): Promise<{ request: ApprovalRequest; expiresAt: Date } | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusal = await receiptBlocker(tx, purchaseId, now());
      if (refusal) {
        await transition(tx, purchaseId, 'proposed', 'charging');
        await appendEvent(tx, purchaseId, 'charge_refused', { reason: refusal });
        await transition(tx, purchaseId, 'charging', 'failed');
        return null;
      }
      await transition(tx, purchaseId, 'proposed', 'awaiting_approval');
      const expiresAt = new Date(now().getTime() + APPROVAL_WINDOW_MS);
      await enqueue(tx, 'approval_expiry', { purchaseId }, expiresAt);
      const request = {
        amountCents: totalCents,
        description: `Behest order ${purchaseId}`,
        invoiceId: purchaseId,
        returnUrl: `${appUrl}/api/purchases/return`,
        cancelUrl: `${appUrl}/buyer/approvals?cancelled=${purchaseId}`,
        requestId: `${purchaseId}:approval`,
      };
      return { request, expiresAt };
    });
  } catch (error) {
    if (error instanceof StaleTransition) return null;
    throw error;
  }
}

/**
 * With the purchase locked, moves it from `awaiting_approval` to `charging`, approved by the buyer,
 * and records the capture with recordCharge. Returns the capture to send, or null, changing
 * nothing, for a purchase in any other status.
 */
async function enterCharging({ db, now }: CaptureDeps, purchaseId: string, orderId: string): Promise<PaymentRequest | null> {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (purchase?.status !== 'awaiting_approval') return null;
    await transition(tx, purchaseId, 'awaiting_approval', 'charging', { approver: 'human' });
    const request = { orderId, requestId: `${purchaseId}:capture` };
    await recordCharge(tx, purchaseId, request, now());
    return request;
  });
}

/**
 * Asks PayPal for the approval order, and once more if that throws, logging the first failure. Both
 * carry the same request id, so PayPal creates one order.
 */
async function sendApprovalOrder(paypal: PaypalPort, purchaseId: string, request: ApprovalRequest): Promise<ApprovalOrder> {
  try {
    return await paypal.createApprovalOrder(request);
  } catch (error) {
    console.error(`${FIRST_ATTEMPT_FAILED} purchase ${purchaseId}: ${error instanceof Error ? error.message : String(error)}`);
    return paypal.createApprovalOrder(request);
  }
}

/**
 * Stores the order and its approval link and logs them, with when the approval window closes, as
 * the `approval_order` event, while the purchase still awaits an order. A purchase PayPal sends
 * back for approval later expires when that window closes (see reopenApproval in charge.ts).
 */
async function storeApprovalOrder(db: Db, purchaseId: string, order: RecordedOrder): Promise<void> {
  await db.transaction(async (tx) => {
    const stored = await tx
      .update(purchases)
      .set({ paypalOrderId: order.orderId, approveUrl: order.approveUrl })
      .where(and(eq(purchases.id, purchaseId), eq(purchases.status, 'awaiting_approval'), isNull(purchases.paypalOrderId)))
      .returning({ id: purchases.id });
    if (stored.length > 0) await appendEvent(tx, purchaseId, 'approval_order', order);
  });
}

/** Cancels a purchase whose approval order PayPal could not create, logging `approval_order_failed`. */
async function cancelUnsentApproval(db: Db, purchaseId: string, requestId: string, error: unknown): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await appendEvent(tx, purchaseId, 'approval_order_failed', { requestId, ...describeFailure(error) });
      await transition(tx, purchaseId, 'awaiting_approval', 'cancelled');
    });
  } catch (stale) {
    // The purchase has moved on, so the failure is not logged against it.
    if (!(stale instanceof StaleTransition)) throw stale;
  }
}
