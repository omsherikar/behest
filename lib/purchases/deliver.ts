import { eq } from 'drizzle-orm';
import { payouts, purchases, receipts, refunds, sellers } from '@/lib/db/schema';
import type { PaypalPort } from '@/lib/paypal/port';
import type { PurchaseDeps } from './deps';
import { appendEvent, transition } from './events';
import { describeFailure, payoutSeller } from './settle';

// Handing a captured purchase to its seller (architecture section 6.2). The seller verifies the
// receipt with only Behest's public key and accepts or rejects the order. An accepted order is paid
// out to the seller. A rejected one is refunded to the buyer from Behest's capture, since Behest is
// the merchant of record and holds the money.
//
// A purchase is delivered once. A seller spends a receipt id on the first order it accepts and
// rejects any later order with that receipt as replayed, and such a rejection must never refund an
// order the seller is filling. completeCapture delivers only from the call that recorded the capture.

type DeliverDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'sellers' | 'now'>;
type SellerAnswer = Awaited<ReturnType<DeliverDeps['sellers']['acceptAgentOrder']>>;
type RefundAnswer = Awaited<ReturnType<PaypalPort['refundCapture']>>;

/** Refund statuses with which PayPal has returned, or is returning, the buyer's money. */
const REFUNDING: ReadonlySet<string> = new Set(['COMPLETED', 'PENDING']);

/**
 * Presents a captured purchase's cart and receipt to its seller. Accepted: logs `seller_accepted`,
 * moves the purchase to `accepted` and pays the seller with payoutSeller, which queues its own poll.
 * Rejected: refunds the buyer (see refundRejectedOrder). If the seller cannot be asked or its answer
 * is lost, the seller may have accepted, so nothing is refunded or paid: a `seller_unknown` event is
 * logged and the purchase stays `captured` for an operator. A purchase no longer `captured` is left
 * alone. Throws for a purchase with no receipt.
 */
export async function deliverToSeller(deps: DeliverDeps, purchaseId: string): Promise<void> {
  const { db } = deps;
  const [order] = await db
    .select({
      status: purchases.status,
      cart: purchases.cart,
      sellerSlug: sellers.slug,
      receiptId: receipts.id,
      receiptJws: receipts.jws,
    })
    .from(purchases)
    .innerJoin(sellers, eq(sellers.id, purchases.sellerId))
    .innerJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!order) throw new Error(`purchase ${purchaseId} has no seller or no receipt to present`);
  if (order.status !== 'captured') return;
  if (!order.cart) throw new Error(`captured purchase ${purchaseId} has no cart`);

  let answer: SellerAnswer;
  try {
    answer = await deps.sellers.acceptAgentOrder({ sellerSlug: order.sellerSlug, cart: order.cart, receiptJws: order.receiptJws });
  } catch (error) {
    await appendEvent(db, purchaseId, 'seller_unknown', describeFailure(error));
    return;
  }

  if (answer.status === 'accepted') {
    await db.transaction(async (tx) => {
      await appendEvent(tx, purchaseId, 'seller_accepted', { receiptId: order.receiptId });
      await transition(tx, purchaseId, 'captured', 'accepted');
    });
    await payoutSeller(deps, purchaseId);
    return;
  }
  await refundRejectedOrder(deps, purchaseId, answer.reason ?? null);
}

/**
 * Refunds the captured amount of an order its seller rejected, logging `seller_rejected` first.
 * With the purchase row locked, it checks that the purchase is still `captured` and that the seller
 * has no payout, since a refund then would pay the money out twice; otherwise it logs
 * `refund_skipped` and leaves the money to an operator. It then writes the refunds row, so the
 * refund is on record before PayPal is asked, and releases the lock: none is held across a PayPal
 * call. A refund PayPal is returning moves the purchase to `refunded`. A refund PayPal answers in
 * another status is logged as `refund_failed`, and one whose answer is lost twice as
 * `refund_unknown`; either way the purchase stays `captured`, still counted against the budget.
 */
async function refundRejectedOrder({ db, paypal }: DeliverDeps, purchaseId: string, reason: string | null): Promise<void> {
  const note = `The seller did not accept Behest order ${purchaseId}.`;
  const refund = await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status, captureId: purchases.paypalCaptureId, totalCents: purchases.totalCents })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    const [payout] = await tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.purchaseId, purchaseId));
    await appendEvent(tx, purchaseId, 'seller_rejected', { reason });

    const withheld =
      purchase.status !== 'captured' ? `the purchase is ${purchase.status}` : payout ? 'the seller has a payout on record' : null;
    if (withheld) {
      await appendEvent(tx, purchaseId, 'refund_skipped', { reason: withheld });
      return null;
    }
    const { captureId, totalCents } = purchase;
    if (!captureId || totalCents === null) throw new Error(`captured purchase ${purchaseId} has no capture or total to refund`);

    const [existing] = await tx
      .select({ id: refunds.id, amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchaseId));
    const [row] = existing
      ? [existing]
      : await tx
          .insert(refunds)
          .values({ purchaseId, amountCents: totalCents, reason: note })
          .returning({ id: refunds.id, amountCents: refunds.amountCents });
    return { ...row, captureId };
  });
  if (!refund) return;

  const request = { captureId: refund.captureId, amountCents: refund.amountCents, note, requestId: `${purchaseId}:refund` };
  let answer: RefundAnswer;
  try {
    answer = await sendRefund(paypal, request);
  } catch (error) {
    await appendEvent(db, purchaseId, 'refund_unknown', { requestId: request.requestId, ...describeFailure(error) });
    return;
  }

  const refunding = REFUNDING.has(answer.status);
  // Recorded before the purchase moves, so nothing that goes wrong with the move can lose the refund.
  await db.transaction(async (tx) => {
    await tx.update(refunds).set({ paypalRefundId: answer.refundId, status: answer.status }).where(eq(refunds.id, refund.id));
    await appendEvent(tx, purchaseId, refunding ? 'refund' : 'refund_failed', {
      refundId: answer.refundId,
      status: answer.status,
      amountCents: refund.amountCents,
    });
  });
  if (refunding) await transition(db, purchaseId, 'captured', 'refunded');
}

/** Asks PayPal for the refund, and once more if that throws. Both carry the same request id, so PayPal refunds at most once. */
async function sendRefund(paypal: PaypalPort, request: Parameters<PaypalPort['refundCapture']>[0]): Promise<RefundAnswer> {
  try {
    return await paypal.refundCapture(request);
  } catch {
    return paypal.refundCapture(request);
  }
}
