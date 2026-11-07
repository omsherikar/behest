import { z } from 'zod';
import { Verdict } from './verdict';

// Payloads of the two signed artifacts (architecture section 5.3). The signer puts the key id
// in the JWS protected header, so it is not repeated here. Both schemas are strict: a payload
// carries exactly these fields and nothing else.

/** Lowercase hex SHA-256, the format of every hash in a mandate or receipt. */
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const cents = z.number().int().positive();
/** Issue time in seconds since the epoch, as in a JWT `iat` claim. */
const issuedAt = z.number().int().nonnegative();

export const ReceiptPayload = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    iss: z.literal('behest'),
    iat: issuedAt,
    mandate: z
      .object({
        id: z.string().min(1),
        policyHash: sha256Hex,
        /** Hash of the signed mandate JWS the purchase ran under. */
        jwsHash: sha256Hex,
      })
      .strict(),
    seller: z.object({ slug: z.string().min(1) }).strict(),
    cart: z
      .object({
        hash: sha256Hex,
        totalCents: cents,
        currency: z.literal('USD'),
        itemCount: z.number().int().positive(),
      })
      .strict(),
    decision: z
      .object({
        purchaseId: z.string().min(1),
        /** Only paid purchases get a receipt, so BLOCK never appears. */
        verdict: Verdict.extract(['ALLOW', 'ASK']),
        approver: z.enum(['policy', 'human']),
        rulesetVersion: z.string().min(1),
        outcomes: z.array(
          z
            .object({
              rule: z.string().min(1),
              result: z.enum(['pass', 'ask', 'block', 'skip']),
            })
            .strict(),
        )
        .min(1),
      })
      .strict(),
    payment: z
      .object({
        processor: z.literal('paypal'),
        orderId: z.string().min(1),
        captureId: z.string().min(1),
        amountCents: cents,
        capturedAt: z.iso.datetime(),
      })
      .strict(),
  })
  .strict();
export type ReceiptPayload = z.infer<typeof ReceiptPayload>;

/** The fields every signed mandate carries, however the buyer confirmed it. */
const mandateFields = {
  v: z.literal(1),
  id: z.string().min(1),
  iss: z.literal('behest'),
  iat: issuedAt,
  /** A hash of the buyer id, so the signed mandate does not reveal it. */
  buyer: z.object({ ref: sha256Hex }).strict(),
  policyHash: sha256Hex,
  /** Hash of the plain-English readback the buyer confirmed. */
  readbackHash: sha256Hex,
  confirmedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
};

/**
 * The buyer's passkey that signed the mandate's hashes: everything a verifier needs to check that
 * signature, so it needs nothing from Behest.
 */
export const MandatePasskey = z
  .object({
    /** The credential id, base64url, as the authenticator reports it. */
    credentialId: z.string().min(1),
    /** The COSE public key, base64url. */
    publicKey: z.string().min(1),
    /** The COSE algorithm of the key, such as -7 for ES256. */
    alg: z.number().int(),
  })
  .strict();
export type MandatePasskey = z.infer<typeof MandatePasskey>;

/**
 * A signed mandate. `confirmation` says how the buyer confirmed it: by a signed-in session alone, or
 * also by signing its hashes with their passkey, which the mandate then names.
 */
export const MandatePayload = z.discriminatedUnion('confirmation', [
  z.object({ ...mandateFields, confirmation: z.literal('session') }).strict(),
  z.object({ ...mandateFields, confirmation: z.literal('passkey'), passkey: MandatePasskey }).strict(),
]);
export type MandatePayload = z.infer<typeof MandatePayload>;
