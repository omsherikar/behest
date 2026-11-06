import { decodeJwt, decodeProtectedHeader } from 'jose';
import type { Cart } from '@/lib/domain/cart';
import { formatUsd } from '@/lib/domain/money';
import { ReceiptPayload } from '@/lib/domain/receipt';

// The dashboard's receipt card: what a receipt claims, and whether Behest's verifier
// (POST /api/receipts/verify) accepts it against the purchase's cart. The card reads the claims
// straight from the JWS so it can show them even when the verifier cannot be asked; only the
// verifier's answer marks them as verified.

export type DecodedReceipt = { keyId: string | null; algorithm: string | null; payload: ReceiptPayload };

/** A receipt's header and payload, read without checking the signature. Null if it is not a readable receipt. */
export function decodeReceipt(jws: string): DecodedReceipt | null {
  try {
    const header = decodeProtectedHeader(jws);
    const payload = ReceiptPayload.safeParse(decodeJwt(jws));
    if (!payload.success) return null;
    return { keyId: header.kid ?? null, algorithm: header.alg ?? null, payload: payload.data };
  } catch {
    return null;
  }
}

/**
 * One claim a receipt makes. `checked` claims are the ones a seller checks against the cart it
 * received (signature, seller, cart hash, amount); `signed` claims are carried under the signature.
 */
export type ReceiptClaim = { kind: 'checked' | 'signed'; label: string; value: string };

// 6 Nov 2026, 11:20
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const utcTime = (date: Date) => `${dateTime.format(date)} UTC`;

/** A long hash or id cut to its ends, enough to compare by eye. */
const short = (value: string) => (value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-7)}` : value);

const RESULT_WORDS = { pass: 'passed', ask: 'asked', block: 'blocked', skip: 'skipped' } as const;

function ruleTally(outcomes: ReceiptPayload['decision']['outcomes']) {
  const counts = new Map<keyof typeof RESULT_WORDS, number>();
  for (const { result } of outcomes) counts.set(result, (counts.get(result) ?? 0) + 1);
  const parts = (['pass', 'ask', 'block', 'skip'] as const).flatMap((result) =>
    counts.has(result) ? [`${counts.get(result)} ${RESULT_WORDS[result]}`] : [],
  );
  return `${outcomes.length} rules: ${parts.join(', ')}`;
}

export function receiptClaims({ keyId, algorithm, payload: p }: DecodedReceipt): ReceiptClaim[] {
  const items = p.cart.itemCount === 1 ? '1 item' : `${p.cart.itemCount} items`;
  return [
    {
      kind: 'checked',
      label: 'Signature',
      value: `${algorithm ?? 'No algorithm'}, ${keyId ? `key ${keyId}` : 'no key id'}`,
    },
    { kind: 'checked', label: 'Seller', value: p.seller.slug },
    { kind: 'checked', label: 'Cart', value: `${items}, hash ${short(p.cart.hash)}` },
    {
      kind: 'checked',
      label: 'Amount',
      value: `${formatUsd(p.payment.amountCents)} paid for a ${formatUsd(p.cart.totalCents)} cart`,
    },
    {
      kind: 'signed',
      label: 'Decision',
      value: `${p.decision.verdict}, approved by ${p.decision.approver === 'human' ? 'the buyer' : 'the policy'} under ${p.decision.rulesetVersion}`,
    },
    { kind: 'signed', label: 'Rules', value: ruleTally(p.decision.outcomes) },
    { kind: 'signed', label: 'Mandate', value: `${short(p.mandate.id)}, policy hash ${short(p.mandate.policyHash)}` },
    {
      kind: 'signed',
      label: 'Payment',
      value: `PayPal capture ${p.payment.captureId} on ${utcTime(new Date(p.payment.capturedAt))}`,
    },
    { kind: 'signed', label: 'Issued', value: `by ${p.iss} on ${utcTime(new Date(p.iat * 1000))}` },
  ];
}

/** The verifier's answer: the verified payload, its reason for rejecting, or why it could not be asked. */
export type Verification =
  | { state: 'verified'; payload: ReceiptPayload }
  | { state: 'rejected'; reason: string }
  | { state: 'unavailable'; message: string };

export type VerifyRequest = { jws: string; cart: Cart; sellerSlug: string };

export const VERIFY_ENDPOINT = '/api/receipts/verify';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Asks the verifier route about a receipt. Never throws: every failure is an `unavailable` answer. */
export async function verifyReceipt(
  request: VerifyRequest,
  { fetch: fetchFn = fetch, endpoint = VERIFY_ENDPOINT, signal }: { fetch?: typeof fetch; endpoint?: string; signal?: AbortSignal } = {},
): Promise<Verification> {
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch {
    return { state: 'unavailable', message: 'The receipt verifier could not be reached.' };
  }
  if (response.status === 404) {
    return { state: 'unavailable', message: 'The receipt verifier is not available on this server.' };
  }

  const body: unknown = await response.json().catch(() => null);
  if (isRecord(body) && body.ok === true) {
    const payload = ReceiptPayload.safeParse(body.payload);
    return payload.success
      ? { state: 'verified', payload: payload.data }
      : { state: 'unavailable', message: 'The receipt verifier answered with something other than a receipt.' };
  }
  if (isRecord(body) && body.ok === false && typeof body.reason === 'string') {
    return { state: 'rejected', reason: body.reason };
  }
  return { state: 'unavailable', message: `The receipt verifier answered with status ${response.status}.` };
}
