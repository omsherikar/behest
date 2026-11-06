import { and, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { buyers, mandates } from '@/lib/db/schema';
import { MandatePolicy } from '@/lib/domain/policy';
import type { MandatePayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import type { Signer } from '@/lib/receipts/sign';
import { renderReadback } from './readback';

// Turns a policy the buyer has confirmed into their signed mandate. The callers only pass a policy
// whose compile left no open questions. The readback is rendered again here from the validated
// policy, so the stored and signed readback is the one this code produces, not one sent in.

/**
 * Validates and signs the buyer's confirmed policy, then stores it as their one active mandate:
 * in one transaction it locks the buyer, revokes any active mandate they hold and inserts the
 * new one. Throws, storing nothing, for an invalid policy, an expiry that is not after now, or a
 * buyer that does not exist.
 */
export async function confirmMandate(
  deps: { db: Db; signer: Signer; now: () => Date },
  i: { buyerId: string; text: string; policy: MandatePolicy },
): Promise<{ mandateId: string; jws: string }> {
  const policy = MandatePolicy.parse(i.policy);
  const confirmedAt = deps.now();
  if (policy.expiresAt !== null && Date.parse(policy.expiresAt) <= confirmedAt.getTime()) {
    throw new Error('the mandate expiry is not after the time it is confirmed');
  }

  const id = crypto.randomUUID();
  const readback = renderReadback(policy);
  const payload: MandatePayload = {
    v: 1,
    id,
    iss: 'behest',
    iat: Math.floor(confirmedAt.getTime() / 1000),
    buyer: { ref: sha256Hex(i.buyerId) },
    policyHash: hashOf(policy),
    readbackHash: hashOf(readback),
    confirmedAt: confirmedAt.toISOString(),
    confirmation: 'session',
    expiresAt: policy.expiresAt,
  };
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
    if (!buyer) throw new Error(`no buyer has the id ${i.buyerId}`);

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
      policyHash: payload.policyHash,
      readback,
      readbackHash: payload.readbackHash,
      jws,
      status: 'active',
      confirmedAt,
      expiresAt: policy.expiresAt === null ? null : new Date(policy.expiresAt),
    });
  });

  return { mandateId: id, jws };
}
