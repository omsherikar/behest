import { createHash } from 'node:crypto';
import { canonicalJson } from '@/lib/receipts/canonical';

/**
 * The WebAuthn challenge a buyer's passkey signs to confirm a mandate, base64url: the SHA-256 of the
 * canonical JSON (RFC 8785) of the mandate's policy hash and readback hash, the nonce Behest issued
 * and when the chance to sign ends, in whole seconds since the epoch. Anyone holding those four
 * values can compute it again, so the signature over it commits the buyer to exactly that mandate.
 */
export function mandateChallenge(i: { policyHash: string; readbackHash: string; nonce: string; exp: number }): string {
  const { policyHash, readbackHash, nonce, exp } = i;
  return createHash('sha256').update(canonicalJson({ policyHash, readbackHash, nonce, exp })).digest('base64url');
}
