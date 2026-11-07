import { and, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { buyerPasskeys, buyers, mandates } from '@/lib/db/schema';
import type { BuyerAssertion } from '@/lib/domain/passkey';
import { MandatePolicy } from '@/lib/domain/policy';
import type { MandatePasskey, MandatePayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import type { Signer } from '@/lib/receipts/sign';
import { mandateChallenge } from './challenge';
import { renderReadback } from './readback';

// Turns a policy the buyer has confirmed into their signed mandate. The callers only pass a policy
// whose compile left no open questions. The readback is rendered again here from the validated
// policy, so the stored and signed readback is the one this code produces, not one sent in. A buyer
// may also have signed the mandate's hashes with their passkey; the mandate then names that passkey
// and keeps the signature beside it.

export type MandateConfirmErrorCode = 'invalid_policy' | 'expired' | 'unknown_buyer' | 'passkey';

const MESSAGES: Record<MandateConfirmErrorCode, string> = {
  invalid_policy: 'the mandate policy is not valid',
  expired: 'the mandate expiry is not after the time it is confirmed',
  unknown_buyer: 'the mandate names a buyer that does not exist',
  passkey: 'the passkey signature does not confirm this mandate',
};

/** Why a mandate was not confirmed. Nothing is stored when one is thrown. */
export class MandateConfirmError extends Error {
  readonly code: MandateConfirmErrorCode;
  constructor(code: MandateConfirmErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'MandateConfirmError';
    this.code = code;
  }
}

/** A buyer's passkey signature over a mandate's hashes, verified against their stored passkey. */
export type PasskeySignature = {
  /** The buyer's stored passkey that signed. */
  passkeyId: string;
  /** The signature counter the assertion reported, which becomes the passkey's. */
  counter: number;
  /** The passkey as the signed mandate names it. */
  passkey: MandatePasskey;
  assertion: BuyerAssertion;
};

/** The policy, validated, with any expiry written as `toISOString` writes it. */
function validPolicy(input: MandatePolicy): MandatePolicy {
  const parsed = MandatePolicy.safeParse(input);
  if (!parsed.success) throw new MandateConfirmError('invalid_policy', { cause: parsed.error });
  const { expiresAt } = parsed.data;
  // One spelling of the instant, so the stored policy, its hash, the payload and the column agree.
  return { ...parsed.data, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
}

/**
 * The policy as a mandate stores it, its readback, and the hashes a signed mandate carries: exactly
 * what confirmMandate would store and sign for it. Throws a MandateConfirmError for a policy that is
 * not valid.
 */
export function mandateHashes(input: MandatePolicy): {
  policy: MandatePolicy;
  readback: string[];
  policyHash: string;
  readbackHash: string;
} {
  const policy = validPolicy(input);
  const readback = renderReadback(policy);
  return { policy, readback, policyHash: hashOf(policy), readbackHash: hashOf(readback) };
}

/**
 * Validates and signs the buyer's confirmed policy, then stores it as their one active mandate:
 * in one transaction it locks the buyer, revokes any active mandate they hold and inserts the
 * new one. Throws a MandateConfirmError, storing nothing, for an invalid policy, an expiry that is
 * not after now, or a buyer that does not exist.
 *
 * With a `passkey` signature, which the caller has verified against the buyer's stored passkey, the
 * mandate is confirmed by passkey: the signed payload names the passkey and the assertion is stored.
 * In the same transaction the passkey's counter moves on to the one the assertion reported. Throws a
 * MandateConfirmError `passkey`, storing nothing, for a signature whose challenge does not commit to
 * this policy and readback, whose nonce already confirmed a mandate, or that the passkey has since
 * signed past.
 */
export async function confirmMandate(
  deps: { db: Db; signer: Signer; now: () => Date },
  i: { buyerId: string; text: string; policy: MandatePolicy; passkey?: PasskeySignature },
): Promise<{ mandateId: string; jws: string }> {
  const { policy, readback, policyHash, readbackHash } = mandateHashes(i.policy);
  const confirmedAt = deps.now();
  if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= confirmedAt.getTime()) {
    throw new MandateConfirmError('expired');
  }
  const signature = i.passkey;
  if (signature) {
    const { nonce, exp, challenge } = signature.assertion;
    if (mandateChallenge({ policyHash, readbackHash, nonce, exp }) !== challenge) throw new MandateConfirmError('passkey');
  }

  const id = crypto.randomUUID();
  const fields = {
    v: 1 as const,
    id,
    iss: 'behest' as const,
    iat: Math.floor(confirmedAt.getTime() / 1000),
    buyer: { ref: sha256Hex(i.buyerId) },
    policyHash,
    readbackHash,
    confirmedAt: confirmedAt.toISOString(),
    expiresAt: policy.expiresAt,
  };
  const payload: MandatePayload = signature
    ? { ...fields, confirmation: 'passkey', passkey: signature.passkey }
    : { ...fields, confirmation: 'session' };
  const jws = await deps.signer.sign(payload, 'behest-mandate+jws');

  await deps.db.transaction(async (tx) => {
    // Two confirms for one buyer queue on this lock, so the second revokes the first's new mandate
    // rather than breaking the one-active-mandate index on insert. It is NO KEY UPDATE, not UPDATE:
    // inserting a purchase takes KEY SHARE on its buyer through the foreign key, which only UPDATE
    // blocks, so a confirm cannot deadlock with the gate holding that buyer's mandate row.
    const [buyer] = await tx
      .select({ id: buyers.id })
      .from(buyers)
      .where(eq(buyers.id, i.buyerId))
      .for('no key update');
    if (!buyer) throw new MandateConfirmError('unknown_buyer');
    if (signature) await usePasskey(tx, i.buyerId, signature, confirmedAt);

    // The database allows one active mandate per buyer, so the old one is revoked first.
    await tx
      .update(mandates)
      .set({ status: 'revoked' })
      .where(and(eq(mandates.buyerId, i.buyerId), eq(mandates.status, 'active')));
    await tx.insert(mandates).values({
      id,
      buyerId: i.buyerId,
      sourceText: i.text,
      policy,
      policyHash,
      readback,
      readbackHash,
      jws,
      confirmation: payload.confirmation,
      buyerAssertion: signature?.assertion ?? null,
      status: 'active',
      confirmedAt,
      expiresAt: policy.expiresAt === null ? null : new Date(policy.expiresAt),
    });
  });

  return { mandateId: id, jws };
}

/**
 * Spends a passkey signature, under the buyer's lock: refuses one whose nonce already confirmed a
 * mandate, then moves the passkey's counter on to the signature's and records when it was used. The
 * counter must go up, or stay at zero for an authenticator that keeps none, so a signature the
 * passkey has since signed past is refused even if a confirm racing this one got there first.
 */
async function usePasskey(tx: Db, buyerId: string, signature: PasskeySignature, usedAt: Date): Promise<void> {
  const [spent] = await tx
    .select({ id: mandates.id })
    .from(mandates)
    .where(and(eq(mandates.buyerId, buyerId), sql`${mandates.buyerAssertion}->>'nonce' = ${signature.assertion.nonce}`))
    .limit(1);
  if (spent) throw new MandateConfirmError('passkey');

  const { counter } = signature;
  const advances = counter === 0 ? eq(buyerPasskeys.counter, 0) : lt(buyerPasskeys.counter, counter);
  const moved = await tx
    .update(buyerPasskeys)
    .set({ counter, lastUsedAt: usedAt })
    .where(and(eq(buyerPasskeys.id, signature.passkeyId), eq(buyerPasskeys.buyerId, buyerId), advances))
    .returning({ id: buyerPasskeys.id });
  if (moved.length === 0) throw new MandateConfirmError('passkey');
}
