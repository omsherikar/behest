import type { Cart } from '../domain/cart';
import type { PurchaseStatus } from '../db/schema';

// What the demo's receipt check shows: a seller refusing a receipt presented with a cart it was not
// signed for, and refusing it again when it comes a second time (scripts/demo-tamper.ts).

/**
 * Statuses at which the seller has already taken the order, so presenting its receipt again can only
 * come back `replayed`. Before them, sending the receipt with its own cart would take the order in
 * Behest's place, which the demo must never do.
 */
const SELLER_TOOK_IT: ReadonlySet<PurchaseStatus> = new Set(['accepted', 'settled', 'disputed', 'resolved']);

export function sellerTookOrder(status: PurchaseStatus): boolean {
  return SELLER_TOOK_IT.has(status);
}

/**
 * The cart with one more of its first item and the total to match: still a well-formed cart, as a
 * middleman would send it, but not the one the receipt was signed for.
 */
export function tamperedCart(cart: Cart): Cart {
  const items = cart.items.map((item, index) => (index === 0 ? { ...item, quantity: item.quantity + 1 } : item));
  return { ...cart, items, totalCents: items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0) };
}

/** The receipt's age in whole minutes from its `iat` claim, read without checking the signature; null if unreadable. */
export function receiptAgeMinutes(jws: string, now: Date): number | null {
  try {
    const payload = JSON.parse(Buffer.from(jws.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iat?: unknown };
    if (typeof payload.iat !== 'number') return null;
    return Math.floor((now.getTime() / 1000 - payload.iat) / 60);
  } catch {
    return null;
  }
}
