import type { Cart } from '@/lib/domain/cart';

// Asking Behest's public verifier (POST /api/receipts/verify) about a receipt, from the browser, in
// audit mode: it checks the signature, the seller, the cart and the amount, and skips freshness and
// replay, which only matter when a seller first takes the order. Plain fetch and plain values, so it
// bundles for the browser without the verifier's own code.

export const VERIFY_ENDPOINT = '/api/receipts/verify';

export type ReceiptCheck =
  | { state: 'verified'; receiptId: string | null }
  | { state: 'rejected'; reason: string }
  | { state: 'unavailable'; message: string };

const REJECTIONS: Record<string, string> = {
  bad_signature: 'The signature does not verify against Behest’s public key.',
  malformed: 'The receipt could not be read.',
  expired: 'The receipt has expired.',
  wrong_seller: 'The receipt names another seller.',
  cart_mismatch: 'The cart does not match the receipt.',
  amount_mismatch: 'The amount does not match the receipt.',
  replayed: 'The receipt was already used.',
};

/** Why the verifier refused a receipt, in words. */
export function rejectionWords(reason: string): string {
  return Object.hasOwn(REJECTIONS, reason) ? REJECTIONS[reason] : 'The verifier refused the receipt.';
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The verifier's answer about `jws` for `cart` and `sellerSlug`. Never throws: a failure is `unavailable`. */
export async function checkReceipt(
  request: { jws: string; cart: Cart; sellerSlug: string },
  fetchFn: typeof fetch = fetch,
): Promise<ReceiptCheck> {
  let response: Response;
  try {
    response = await fetchFn(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, mode: 'audit' }),
    });
  } catch {
    return { state: 'unavailable', message: 'Could not reach the receipt verifier. Check your connection and try again.' };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && isRecord(body) && body.ok === true) {
    const payload = isRecord(body.payload) ? body.payload : null;
    return { state: 'verified', receiptId: payload && typeof payload.id === 'string' ? payload.id : null };
  }
  if (response.ok && isRecord(body) && body.ok === false && typeof body.reason === 'string') {
    return { state: 'rejected', reason: rejectionWords(body.reason) };
  }
  if (response.status === 429) return { state: 'unavailable', message: 'The verifier is busy. Wait a minute and try again.' };
  return { state: 'unavailable', message: 'The receipt verifier did not give an answer. Try again in a minute.' };
}
