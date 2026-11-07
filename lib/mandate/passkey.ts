import { randomBytes } from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { cose, decodeCredentialPublicKey, isoBase64URL } from '@simplewebauthn/server/helpers';
import { and, eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { buyerPasskeys, type mandates } from '@/lib/db/schema';
import { BuyerAssertion } from '@/lib/domain/passkey';
import type { MandatePolicy } from '@/lib/domain/policy';
import { MandatePayload } from '@/lib/domain/receipt';
import { type PasskeyDeps, relyingParty } from '@/lib/passkeys/relying-party';
import { issueTicket, readTicket, TICKET_SECONDS, ticketExpiry } from '@/lib/passkeys/ticket';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { mandateChallenge } from './challenge';
import { mandateHashes, type PasskeySignature } from './confirm';

// Confirming a mandate with the buyer's passkey, so that the buyer's own device signs the exact
// mandate they confirm. Behest issues a challenge that commits to the mandate's policy and readback
// hashes, a nonce and an expiry; the buyer's device signs it; Behest checks that signature against
// the passkey it stored for that buyer before it signs the mandate itself. Afterwards anyone can
// check the buyer's signature from the stored mandate alone, with verifyMandatePasskey.

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

/** The browser's assertion, as @simplewebauthn/browser sends it. Only these fields are kept. */
const AssertionJSON = z.object({
  id: base64url,
  rawId: base64url,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
});

const NOT_SIGNED = { ok: false } as const;

/** The COSE algorithm of a COSE public key, or null when it names none. */
function algorithmOf(publicKey: Uint8Array<ArrayBuffer>): number | null {
  const alg = decodeCredentialPublicKey(publicKey).get(cose.COSEKEYS.alg);
  return typeof alg === 'number' ? alg : null;
}

/**
 * The options for the buyer's passkeys to sign the mandate `policy` would become, and the ticket
 * holding the nonce and expiry its challenge commits to. The challenge commits to the hashes
 * confirmMandate would sign, so only that exact mandate can be confirmed with the signature. Says
 * so when the buyer has no passkey yet. Throws a MandateConfirmError for a policy that is not valid.
 */
export async function signingOptions(
  { db, origin, now }: PasskeyDeps,
  i: { buyerId: string; policy: MandatePolicy },
): Promise<{ ok: true; options: PublicKeyCredentialRequestOptionsJSON; ticket: string } | { ok: false; reason: 'no_passkey' }> {
  const { policyHash, readbackHash } = mandateHashes(i.policy);
  const passkeys = await db
    .select({ id: buyerPasskeys.credentialId, transports: buyerPasskeys.transports })
    .from(buyerPasskeys)
    .where(eq(buyerPasskeys.buyerId, i.buyerId));
  if (passkeys.length === 0) return { ok: false, reason: 'no_passkey' };

  const nonce = randomBytes(16).toString('base64url');
  const exp = ticketExpiry(now());
  const options = await generateAuthenticationOptions({
    rpID: relyingParty(origin).rpID,
    allowCredentials: passkeys,
    // The digest's bytes: a string would be signed as its UTF-8 text.
    challenge: isoBase64URL.toBuffer(mandateChallenge({ policyHash, readbackHash, nonce, exp })),
    timeout: TICKET_SECONDS * 1000,
    userVerification: 'preferred',
  });
  const ticket = issueTicket({ kind: 'mandate_sign', buyer: sha256Hex(i.buyerId), nonce, exp });
  return { ok: true, options, ticket };
}

/**
 * Checks the buyer's assertion over the mandate `policy` would become, and returns the signature for
 * confirmMandate to store. Refuses when the ticket is not one Behest issued to this buyer or has
 * expired, when the credential is not one of this buyer's passkeys, when the assertion does not sign
 * the challenge for this policy at this origin, or when the passkey's counter has gone backwards.
 * Throws a MandateConfirmError for a policy that is not valid, and on database errors.
 */
export async function verifyMandateAssertion(
  { db, origin, now }: PasskeyDeps,
  i: { buyerId: string; policy: MandatePolicy; assertion: unknown; ticket: unknown },
): Promise<{ ok: true; signature: PasskeySignature } | { ok: false }> {
  const { policyHash, readbackHash } = mandateHashes(i.policy);
  const claims = readTicket(i.ticket, 'mandate_sign', now());
  if (!claims || claims.buyer !== sha256Hex(i.buyerId)) return NOT_SIGNED;
  const parsed = AssertionJSON.safeParse(i.assertion);
  if (!parsed.success) return NOT_SIGNED;
  const { id, rawId, response } = parsed.data;

  const [passkey] = await db
    .select()
    .from(buyerPasskeys)
    .where(and(eq(buyerPasskeys.credentialId, id), eq(buyerPasskeys.buyerId, i.buyerId)));
  if (!passkey) return NOT_SIGNED;

  const { nonce, exp } = claims;
  const challenge = mandateChallenge({ policyHash, readbackHash, nonce, exp });
  const publicKey = isoBase64URL.toBuffer(passkey.publicKey);
  let counter: number;
  try {
    const verified = await verifyAuthenticationResponse({
      response: { id, rawId, type: 'public-key', response, clientExtensionResults: {} },
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: relyingParty(origin).rpID,
      // The library refuses a counter that does not go up, unless both stay at zero.
      credential: { id: passkey.credentialId, publicKey, counter: passkey.counter, transports: passkey.transports },
      // The options prefer user verification without requiring it.
      requireUserVerification: false,
    });
    if (!verified.verified) return NOT_SIGNED;
    counter = verified.authenticationInfo.newCounter;
  } catch {
    return NOT_SIGNED;
  }
  const alg = algorithmOf(publicKey);
  if (alg === null) return NOT_SIGNED;

  return {
    ok: true,
    signature: {
      passkeyId: passkey.id,
      counter,
      passkey: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, alg },
      assertion: {
        credentialId: passkey.credentialId,
        authenticatorData: response.authenticatorData,
        clientDataJSON: response.clientDataJSON,
        signature: response.signature,
        challenge,
        nonce,
        exp,
      },
    },
  };
}

/** The stored mandate fields verifyMandatePasskey reads. */
export type StoredMandate = Pick<
  typeof mandates.$inferSelect,
  'jws' | 'policy' | 'readback' | 'policyHash' | 'readbackHash' | 'confirmation' | 'buyerAssertion'
>;

/**
 * Whether a buyer's passkey signed the mandate, and if not, why not:
 * - `session`: the buyer confirmed it by session alone, so there is no passkey signature;
 * - `malformed`: the signed mandate or the stored assertion cannot be read;
 * - `hash_mismatch`: the stored policy or readback does not hash to what the signed mandate carries;
 * - `bad_signature`: the assertion does not sign this mandate's challenge, at `origin`, with the
 *   passkey the signed mandate names.
 */
export type PasskeyCheck =
  | { verified: true; credentialId: string }
  | { verified: false; reason: 'session' | 'malformed' | 'hash_mismatch' | 'bad_signature' };

/**
 * Checks a stored mandate's passkey signature from the mandate alone: it recomputes the challenge
 * from the policy and readback hashes the signed mandate carries and the nonce and expiry stored
 * with the assertion, and verifies the assertion, made at Behest's `origin`, with the public key the
 * signed mandate names. It reads nothing else, so anyone holding the mandate can run the same check.
 * It does not check Behest's own signature on the mandate JWS, which binds that key to the buyer;
 * the mandate JWS verifies against Behest's public key set for that.
 */
export async function verifyMandatePasskey(mandate: StoredMandate, origin: string): Promise<PasskeyCheck> {
  if (mandate.confirmation !== 'passkey') return { verified: false, reason: 'session' };
  let payload: MandatePayload;
  try {
    payload = MandatePayload.parse(decodeJwt(mandate.jws));
  } catch {
    return { verified: false, reason: 'malformed' };
  }
  const stored = BuyerAssertion.safeParse(mandate.buyerAssertion);
  if (payload.confirmation !== 'passkey' || !stored.success) return { verified: false, reason: 'malformed' };

  const { policyHash, readbackHash, passkey } = payload;
  const hashesHold =
    mandate.policyHash === policyHash &&
    hashOf(mandate.policy) === policyHash &&
    mandate.readbackHash === readbackHash &&
    hashOf(mandate.readback) === readbackHash;
  if (!hashesHold) return { verified: false, reason: 'hash_mismatch' };

  const bad = { verified: false, reason: 'bad_signature' } as const;
  const { credentialId, authenticatorData, clientDataJSON, signature, nonce, exp } = stored.data;
  const challenge = mandateChallenge({ policyHash, readbackHash, nonce, exp });
  if (credentialId !== passkey.credentialId || stored.data.challenge !== challenge) return bad;
  try {
    const publicKey = isoBase64URL.toBuffer(passkey.publicKey);
    if (algorithmOf(publicKey) !== passkey.alg) return bad;
    const response: AuthenticationResponseJSON = {
      id: credentialId,
      rawId: credentialId,
      type: 'public-key',
      response: { clientDataJSON, authenticatorData, signature },
      clientExtensionResults: {},
    };
    const { verified } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: relyingParty(origin).rpID,
      // A counter of zero passes any counter the assertion reported: this checks the signature, not its order.
      credential: { id: credentialId, publicKey, counter: 0 },
      requireUserVerification: false,
    });
    return verified ? { verified: true, credentialId } : bad;
  } catch {
    return bad;
  }
}
