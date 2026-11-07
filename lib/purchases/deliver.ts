import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
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
// rejects any later order with that receipt as replayed, or as expired once the receipt has aged
// out, and such a rejection must never refund an order the seller is filling. completeCapture
// delivers only from the call that recorded the capture, and a rejection that may follow an earlier
// acceptance is never refunded.

type DeliverDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'sellers' | 'now'>;
type SellerAnswer = Awaited<ReturnType<DeliverDeps['sellers']['acceptAgentOrder']>>;
type RefundAnswer = Awaited<ReturnType<PaypalPort['refundCapture']>>;
/** A refunds row written before PayPal was asked, and the capture it refunds. */
type HeldRefund = { id: string; amountCents: number; captureId: string };

/**
 * Rejections a seller also gives when an order it has already accepted is delivered again: the
 * receipt is spent (`replayed`) or has aged out (`expired`). They do not prove the seller turned the
 * order down.
 */
const AMBIGUOUS_REJECTIONS: ReadonlySet<string> = new Set(['replayed', 'expired']);

/** Refund statuses with which PayPal has returned, or is returning, the buyer's money. */
const REFUNDING: ReadonlySet<string> = new Set(['COMPLETED', 'PENDING']);

/**
 * Presents a captured purchase's cart and receipt to its seller. Accepted: logs `seller_accepted`,
 * moves the purchase to `accepted` and pays the seller with payoutSeller, which queues its own poll.
 * Rejected: refunds the buyer (see refundRejectedOrder), unless the reason is one a seller also
 * gives an order it accepted earlier. If the seller cannot be asked or its answer is lost, or its
 * rejection is such an ambiguous one, the seller may have accepted, so nothing is refunded or paid: a
 * `seller_unknown` or `seller_ambiguous` event is logged and the purchase stays `captured` for an
 * operator. A purchase no longer `captured` is left alone. Throws for a purchase with no receipt.
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
  if (answer.reason !== undefined && AMBIGUOUS_REJECTIONS.has(answer.reason)) {
    await appendEvent(db, purchaseId, 'seller_ambiguous', { reason: answer.reason });
    return;
  }
  await refundRejectedOrder(deps, purchaseId, answer.reason ?? null);
}

/**
 * Refunds the captured amount of an order its seller rejected, logging `seller_rejected` first.
 * With the purchase row locked, it checks that the purchase is still `captured` and that the seller
 * has no payout, since a refund then would pay the money out twice, and that the capture has no
 * refund on record but Behest's own for this rejection, since another one (such as a partial refund
 * made at PayPal) would make the full amount wrong; otherwise it logs `refund_skipped` and leaves the
 * money to an operator. It then writes its own refunds row, or reuses the one an earlier attempt
 * wrote, so the refund is on record before PayPal is asked, and releases the lock: none is held
 * across a PayPal call. A refund PayPal is returning moves the purchase to `refunded`. A refund PayPal answers in
 * another status is logged as `refund_failed`, and one whose answer is lost twice as
 * `refund_unknown`; either way the purchase stays `captured`, still counted against the budget.
 */
async function refundRejectedOrder({ db, paypal }: DeliverDeps, purchaseId: string, reason: string | null): Promise<void> {
  const note = refundNote(purchaseId);
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

    // Behest's own refund of a rejection is the row carrying its note. Any other refund of the
    // capture is left alone, and so is the money, for an operator.
    const recorded = await tx
      .select({ id: refunds.id, amountCents: refunds.amountCents, reason: refunds.reason })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchaseId));
    if (recorded.some((row) => row.reason !== note)) {
      await appendEvent(tx, purchaseId, 'refund_skipped', { reason: 'the capture has another refund on record' });
      return null;
    }
    const [existing] = recorded;
    const [row] = existing
      ? [{ id: existing.id, amountCents: existing.amountCents }]
      : await tx
          .insert(refunds)
          .values({ purchaseId, amountCents: totalCents, reason: note })
          .returning({ id: refunds.id, amountCents: refunds.amountCents });
    return { ...row, captureId };
  });
  if (!refund) return;
  await sendHeldRefund({ db, paypal }, purchaseId, refund);
}

/**
 * Asks PayPal again for the refund of a rejected order whose answer was lost twice, logged as
 * `refund_unknown`: the periodic pass's retry. It sends exactly what the first attempt sent, the
 * same request id, note and amount, so PayPal either reports the refund it already made or makes
 * it now, and never refunds twice; the answer is then recorded as for the first attempt. With the
 * purchase row locked, it checks that the purchase is still `captured`, the seller has no payout and
 * Behest's own refunds row (the one carrying its note) still has no PayPal refund id, and releases
 * the lock before PayPal is asked.
 * Returns whether PayPal was asked.
 */
export async function retryLostRefund({ db, paypal }: Pick<DeliverDeps, 'db' | 'paypal'>, purchaseId: string): Promise<boolean> {
  const refund = await db.transaction(async (tx): Promise<HeldRefund | null> => {
    const [purchase] = await tx
      .select({ status: purchases.status, captureId: purchases.paypalCaptureId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (purchase?.status !== 'captured' || !purchase.captureId) return null;
    const [payout] = await tx.select({ id: payouts.id }).from(payouts).where(eq(payouts.purchaseId, purchaseId));
    if (payout) return null;
    const [row] = await tx
      .select({ id: refunds.id, amountCents: refunds.amountCents })
      .from(refunds)
      .where(and(eq(refunds.purchaseId, purchaseId), isNull(refunds.paypalRefundId), eq(refunds.reason, refundNote(purchaseId))));
    return row ? { ...row, captureId: purchase.captureId } : null;
  });
  if (!refund) return false;
  await sendHeldRefund({ db, paypal }, purchaseId, refund);
  return true;
}

/** What Behest tells the buyer when it refunds an order its seller rejected. */
function refundNote(purchaseId: string): string {
  return `The seller did not accept Behest order ${purchaseId}.`;
}

/**
 * Sends the refund a refunds row already holds, under the purchase's one refund request id, and
 * records PayPal's answer. A refund PayPal is returning moves the purchase to `refunded`. A refund
 * PayPal answers in another status is logged as `refund_failed`, and one whose answer is lost twice
 * as `refund_unknown`; either way the purchase stays `captured`, still counted against the budget.
 */
async function sendHeldRefund({ db, paypal }: { db: Db; paypal: PaypalPort }, purchaseId: string, refund: HeldRefund): Promise<void> {
  const request = {
    captureId: refund.captureId,
    amountCents: refund.amountCents,
    note: refundNote(purchaseId),
    requestId: `${purchaseId}:refund`,
  };
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
