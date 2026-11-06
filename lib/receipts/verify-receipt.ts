import type { JWK } from 'jose';
import type { Cart } from '@/lib/domain/cart';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { hashOf } from './canonical';
import { VerifyError, verifyJws } from './sign';

// What a seller runs on an agent order (architecture section 5.3). It needs nothing but Behest's
// public key set, the receipt and the cart the seller received, and it reads no Behest table, so
// any outside seller can run exactly the same checks.

/** Why a receipt was refused, in the order the checks run. */
export type ReceiptRejection =
  | 'bad_signature'
  | 'malformed'
  | 'expired'
  | 'wrong_seller'
  | 'cart_mismatch'
  | 'amount_mismatch'
  | 'replayed';

/** A receipt is accepted for 15 minutes after it was issued. */
const MAX_AGE_SECONDS = 15 * 60;
/** How far ahead of the seller's clock the issuer's clock may run. */
const MAX_CLOCK_SKEW_SECONDS = 60;

/**
 * The claims a receipt makes about `cart`: what the issuer signs, and what a seller recomputes
 * from the cart it received. `itemCount` counts units (the sum of the quantities), not lines.
 */
export function cartClaims(cart: Cart): ReceiptPayload['cart'] {
  return {
    hash: hashOf(cart),
    totalCents: cart.totalCents,
    currency: cart.currency,
    itemCount: cart.items.reduce((units, item) => units + item.quantity, 0),
  };
}

/**
 * Verifies the receipt presented with an agent order. The checks run in the order of
 * ReceiptRejection, and the first that fails is the reason. `seen` is asked about the receipt id
 * from the verified payload, and only once every other check has passed. Every other failure is
 * a rejection, but an error from `seen` propagates: a replay store that cannot answer says
 * nothing about the receipt, so the caller decides what to do.
 */
export async function verifyReceipt(i: {
  jws: string;
  cart: Cart;
  sellerSlug: string;
  jwks: { keys: JWK[] };
  now: Date;
  seen: (receiptId: string) => Promise<boolean>;
}): Promise<{ ok: true; payload: ReceiptPayload } | { ok: false; reason: ReceiptRejection }> {
  let payload: ReceiptPayload;
  try {
    payload = await verifyJws(i.jws, 'behest-receipt+jws', i.jwks, ReceiptPayload);
    const reason = firstMismatch(payload, i);
    if (reason) return { ok: false, reason };
  } catch (error) {
    return { ok: false, reason: rejectionFor(error) };
  }
  if (await i.seen(payload.id)) return { ok: false, reason: 'replayed' };
  return { ok: true, payload };
}

/** The first claim of an authentic receipt that does not hold for this seller, cart and time. */
function firstMismatch(
  payload: ReceiptPayload,
  { cart, sellerSlug, now }: { cart: Cart; sellerSlug: string; now: Date },
): ReceiptRejection | null {
  const age = now.getTime() / 1000 - payload.iat;
  // Written as the condition to accept, so a clock reading that is not a number rejects.
  if (!(age >= -MAX_CLOCK_SKEW_SECONDS && age <= MAX_AGE_SECONDS)) return 'expired';
  if (payload.seller.slug !== sellerSlug || cart.seller.slug !== sellerSlug) return 'wrong_seller';
  const claims = cartClaims(cart);
  if (
    payload.cart.hash !== claims.hash ||
    payload.cart.itemCount !== claims.itemCount ||
    payload.cart.totalCents !== claims.totalCents
  ) {
    return 'cart_mismatch';
  }
  if (payload.payment.amountCents !== cart.totalCents) return 'amount_mismatch';
  return null;
}

/**
 * A signature that does not verify against the key set, whether by another key or under a key id
 * the set does not hold, is bad_signature. Anything else, including a mandate presented as a
 * receipt or an input that makes a check throw, is malformed.
 */
function rejectionFor(error: unknown): ReceiptRejection {
  if (error instanceof VerifyError && (error.code === 'bad_signature' || error.code === 'unknown_key')) {
    return 'bad_signature';
  }
  return 'malformed';
}
