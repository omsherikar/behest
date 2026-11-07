import { createHash } from 'node:crypto';
import {
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { eq } from 'drizzle-orm';
import { buyerPasskeys, buyers } from '@/lib/db/schema';
import { sha256Hex } from '@/lib/receipts/canonical';
import { type PasskeyDeps, relyingParty } from './relying-party';
import { issueTicket, readTicket, TICKET_SECONDS, ticketExpiry } from './ticket';

// Registering a passkey (a WebAuthn credential) to the buyer's account, so that it can sign the
// mandates they confirm. Behest asks for no attestation: what matters is that the same key signs
// later, not which authenticator holds it. Behest keeps only the public key; the private key stays
// with the authenticator.

/** The transports WebAuthn defines. A registration's list comes from the browser, so others are dropped. */
const TRANSPORTS = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

/**
 * The options for registering a new passkey for the buyer, and the ticket that carries their
 * challenge to registerPasskey. The buyer's own passkeys are excluded, so a device registers once.
 * The user handle is a hash of the buyer id, so the authenticator never holds the id itself.
 * Throws for a buyer that does not exist.
 */
export async function registrationOptions(
  { db, origin, now }: PasskeyDeps,
  buyerId: string,
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; ticket: string }> {
  const [buyer] = await db.select({ name: buyers.name }).from(buyers).where(eq(buyers.id, buyerId));
  if (!buyer) throw new Error('there is no such buyer to register a passkey for');
  const existing = await db
    .select({ id: buyerPasskeys.credentialId, transports: buyerPasskeys.transports })
    .from(buyerPasskeys)
    .where(eq(buyerPasskeys.buyerId, buyerId));

  const { rpName, rpID } = relyingParty(origin);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: buyer.name,
    userDisplayName: buyer.name,
    userID: new Uint8Array(createHash('sha256').update(buyerId).digest()),
    timeout: TICKET_SECONDS * 1000,
    attestationType: 'none',
    excludeCredentials: existing,
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const ticket = issueTicket({
    kind: 'passkey_register',
    buyer: sha256Hex(buyerId),
    challenge: options.challenge,
    exp: ticketExpiry(now()),
  });
  return { options, ticket };
}

/**
 * Verifies the browser's answer to registrationOptions and stores the new passkey for the buyer.
 * Refuses, storing nothing, when the ticket is not one Behest issued to this buyer or has expired,
 * when the response does not answer the ticket's challenge for this origin, or when the credential
 * is already registered. A failure to store anything else, such as a database error, is thrown.
 */
export async function registerPasskey(
  { db, origin, now }: PasskeyDeps,
  i: { buyerId: string; response: unknown; ticket: unknown },
): Promise<{ ok: true; credentialId: string } | { ok: false }> {
  const claims = readTicket(i.ticket, 'passkey_register', now());
  if (!claims || claims.buyer !== sha256Hex(i.buyerId)) return { ok: false };

  const { rpID } = relyingParty(origin);
  let credential: WebAuthnCredential;
  try {
    const verified = await verifyRegistrationResponse({
      // Whatever the browser sent: verification refuses anything that is not a registration response.
      response: i.response as RegistrationResponseJSON,
      expectedChallenge: claims.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      // The options prefer user verification without requiring it.
      requireUserVerification: false,
    });
    if (!verified.verified) return { ok: false };
    credential = verified.registrationInfo.credential;
  } catch {
    return { ok: false };
  }

  const stored = await db
    .insert(buyerPasskeys)
    .values({
      buyerId: i.buyerId,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: (credential.transports ?? []).filter((transport) => TRANSPORTS.has(transport)),
    })
    .onConflictDoNothing({ target: buyerPasskeys.credentialId })
    .returning({ credentialId: buyerPasskeys.credentialId });
  return stored.length > 0 ? { ok: true, credentialId: credential.id } : { ok: false };
}
