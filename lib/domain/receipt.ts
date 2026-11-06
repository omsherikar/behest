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
        ),
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

export const MandatePayload = z
  .object({
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
    confirmation: z.literal('session'),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type MandatePayload = z.infer<typeof MandatePayload>;
