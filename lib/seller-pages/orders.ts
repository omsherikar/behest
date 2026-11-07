import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { payouts, receipts, sellerOrders } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import type { ReceiptRejection } from '@/lib/receipts/verify-receipt';

// The seller orders page: each agent order the seller received, whether its receipt passed the
// seller's check, the cart total and, once accepted, how the seller's payout stands, with the
// receipt as it was presented and the cart received, so the seller can inspect and check it again. What is between
// the buyer and Behest stays there: no purchase, mandate or buyer table is read, so the buyer's
// request, the gate's and the intent check's reasoning and the mandate never reach the seller. The
// payout is found from the receipt id through the receipts table, which names the purchase the
// payout belongs to.

/** How the seller's check of the presented receipt went: it verified, it was refused, or it was a used receipt presented again. */
export type ReceiptCheck = 'verified' | 'rejected' | 'replayed';

/** Where the seller's payout for an accepted order stands. */
export type PayoutState = 'paid' | 'pending' | 'held' | 'failed';

export type SellerOrderRow = {
  id: string;
  /** When the order arrived, as an ISO timestamp. */
  createdAt: string;
  /** The id read from the presented receipt; null when it was too malformed to read one. */
  receiptId: string | null;
  status: 'accepted' | 'rejected';
  check: ReceiptCheck;
  /** Why the receipt was rejected, in words. Null when accepted. */
  reason: string | null;
  /** The total of the cart the seller received, in cents. */
  totalCents: number | null;
  /** The payout's status in words for an accepted order. Null when rejected. */
  payout: string | null;
  /** Where the payout stands, for its badge. Null when rejected. */
  payoutState: PayoutState | null;
  /** The receipt exactly as it was presented with the order. */
  receiptJws: string;
  /** The cart the seller received, which the receipt is checked against. */
  cart: Cart;
};

const REJECTIONS: Record<ReceiptRejection, string> = {
  bad_signature: 'The signature did not verify',
  malformed: 'The receipt could not be read',
  expired: 'The receipt had expired',
  wrong_seller: 'The receipt was for another seller',
  cart_mismatch: 'The cart did not match the receipt',
  amount_mismatch: 'The amount did not match the receipt',
  replayed: 'The receipt was already used',
};

const PAYOUTS: Record<string, string> = { SUCCESS: 'Paid', ONHOLD: 'On hold', CANCELED: 'Cancelled' };

/** PayPal payout statuses that end without the seller being paid. */
const FAILED_PAYOUTS = new Set(['FAILED', 'RETURNED', 'REVERSED', 'BLOCKED', 'DENIED', 'REFUNDED', 'CANCELED', 'UNCLAIMED']);

/** Where a payout stands, from PayPal's status, or `pending` when none was sent yet. */
export function payoutState(status: string | null): PayoutState {
  if (status === 'SUCCESS') return 'paid';
  if (status === 'ONHOLD') return 'held';
  if (status !== null && FAILED_PAYOUTS.has(status)) return 'failed';
  return 'pending';
}

/** `some_code` or `SOME_CODE` as "Some code". */
function words(code: string): string {
  const text = code.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a receipt was rejected, in words. */
export function rejectionLabel(reason: string): string {
  return Object.hasOwn(REJECTIONS, reason) ? REJECTIONS[reason as ReceiptRejection] : words(reason);
}

/** A PayPal payout status, such as SUCCESS or UNCLAIMED, in words. */
export function payoutLabel(status: string): string {
  return Object.hasOwn(PAYOUTS, status) ? PAYOUTS[status] : words(status);
}

/**
 * The query behind the page, newest order first. Only an accepted order is joined to a receipt, and
 * only to a payout made to this same seller, so a rejected order that carries a genuine receipt id
 * never shows that receipt's payout.
 */
export function sellerOrdersQuery(db: Db, sellerId: string) {
  return db
    .select({
      id: sellerOrders.id,
      createdAt: sellerOrders.createdAt,
      receiptId: sellerOrders.receiptId,
      status: sellerOrders.status,
      reason: sellerOrders.reason,
      cart: sellerOrders.cart,
      receiptJws: sellerOrders.receiptJws,
      payoutStatus: payouts.status,
    })
    .from(sellerOrders)
    // The presented receipt id is text and may be anything, so the receipt's uuid is compared as text.
    .leftJoin(receipts, and(eq(sellerOrders.status, 'accepted'), eq(sql`${receipts.id}::text`, sellerOrders.receiptId)))
    .leftJoin(payouts, and(eq(payouts.purchaseId, receipts.purchaseId), eq(payouts.sellerId, sellerOrders.sellerId)))
    .where(eq(sellerOrders.sellerId, sellerId))
    .orderBy(desc(sellerOrders.createdAt), desc(sellerOrders.id));
}

/** The seller's orders as the page shows them. */
export async function sellerOrderRows(db: Db, sellerId: string): Promise<SellerOrderRow[]> {
  const rows = await sellerOrdersQuery(db, sellerId);
  return rows.map((row) => {
    const accepted = row.status === 'accepted';
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      receiptId: row.receiptId,
      status: row.status,
      check: accepted ? 'verified' : row.reason === 'replayed' ? 'replayed' : 'rejected',
      reason: accepted || row.reason === null ? null : rejectionLabel(row.reason),
      totalCents: typeof row.cart?.totalCents === 'number' ? row.cart.totalCents : null,
      payout: accepted ? (row.payoutStatus === null ? 'Not sent yet' : payoutLabel(row.payoutStatus)) : null,
      payoutState: accepted ? payoutState(row.payoutStatus) : null,
      receiptJws: row.receiptJws,
      cart: row.cart,
    };
  });
}
