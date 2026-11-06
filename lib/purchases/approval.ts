import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { purchases } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import type { PaypalPort } from '@/lib/paypal/port';
import { purchaseOutcome } from './charge';
import type { ProposalOutcome, PurchaseDeps } from './deps';
import { appendEvent, StaleTransition, transition } from './events';
import { receiptBlocker } from './receipt';
import { describeFailure } from './settle';

// Purchases the buyer approves themselves (architecture section 6.3). The gate sent the purchase to
// its buyer, so Behest creates a PayPal order and the buyer approves it on PayPal: that approval is
// PayPal's evidence that a human was present. An order left unapproved for three hours is
// cancelled, which releases its budget.

type ApprovalDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'appUrl' | 'now'>;
type ApprovalRequest = Parameters<PaypalPort['createApprovalOrder']>[0];
type ApprovalOrder = Awaited<ReturnType<PaypalPort['createApprovalOrder']>>;

/** How long the buyer has to approve a purchase before it is cancelled and its budget released. */
const APPROVAL_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Sends a purchase the gate referred to its buyer to PayPal for their approval. Moves it from
 * `proposed` to `awaiting_approval` and queues its `approval_expiry` job in one transaction, then
 * asks PayPal for the order the buyer approves, asking once more with the same request id if that
 * throws, and stores the order's id and approval link on the purchase. Creating the order moves no
 * money, so if PayPal cannot answer either time the purchase is cancelled at once, releasing its
 * budget: no buyer can approve an order whose link they never saw. A purchase that could not be
 * given its receipt once captured fails with a `charge_refused` event, PayPal never asked. A purchase
 * another call has already moved on from `proposed` is returned as it stands. Throws, changing
 * nothing, for a purchase whose final verdict is not ASK.
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

  const request = await openApproval(deps, purchaseId, purchase.totalCents);
  if (!request) return purchaseOutcome(db, purchaseId);

  let order: ApprovalOrder;
  try {
    order = await sendApprovalOrder(deps.paypal, request);
  } catch (error) {
    await cancelUnsentApproval(db, purchaseId, request.requestId, error);
    return purchaseOutcome(db, purchaseId);
  }
  await storeApprovalOrder(db, purchaseId, request.requestId, order);
  return purchaseOutcome(db, purchaseId);
}

/**
 * Moves the purchase from `proposed` to `awaiting_approval` and queues its `approval_expiry` job,
 * and returns the order to ask PayPal for. If the purchase could not be given its receipt, it fails
 * the purchase instead, through `charging` as a refused charge does, and returns null; it also
 * returns null for a purchase another call has already moved on.
 */
async function openApproval(
  { db, appUrl, now }: ApprovalDeps,
  purchaseId: string,
  totalCents: number,
): Promise<ApprovalRequest | null> {
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
      await enqueue(tx, 'approval_expiry', { purchaseId }, new Date(now().getTime() + APPROVAL_WINDOW_MS));
      return {
        amountCents: totalCents,
        description: `Behest order ${purchaseId}`,
        invoiceId: purchaseId,
        returnUrl: `${appUrl}/api/purchases/return`,
        cancelUrl: `${appUrl}/buyer/approvals?cancelled=${purchaseId}`,
        requestId: `${purchaseId}:approval`,
      };
    });
  } catch (error) {
    if (error instanceof StaleTransition) return null;
    throw error;
  }
}

/** Asks PayPal for the approval order, and once more if that throws. Both carry the same request id, so PayPal creates one order. */
async function sendApprovalOrder(paypal: PaypalPort, request: ApprovalRequest): Promise<ApprovalOrder> {
  try {
    return await paypal.createApprovalOrder(request);
  } catch {
    return paypal.createApprovalOrder(request);
  }
}

/** Stores the order and its approval link and logs `approval_order`, while the purchase still awaits an order. */
async function storeApprovalOrder(db: Db, purchaseId: string, requestId: string, { orderId, approveUrl }: ApprovalOrder): Promise<void> {
  await db.transaction(async (tx) => {
    const stored = await tx
      .update(purchases)
      .set({ paypalOrderId: orderId, approveUrl })
      .where(and(eq(purchases.id, purchaseId), eq(purchases.status, 'awaiting_approval'), isNull(purchases.paypalOrderId)))
      .returning({ id: purchases.id });
    if (stored.length > 0) await appendEvent(tx, purchaseId, 'approval_order', { requestId, orderId, approveUrl });
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
