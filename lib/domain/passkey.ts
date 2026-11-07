import { z } from 'zod';

// What a buyer's passkey signed when they confirmed a mandate with it, as Behest stores it with the
// mandate. With the public key the signed mandate names, it is everything anyone needs to check that
// the buyer's own device, not Behest, signed the mandate's hashes.

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const BuyerAssertion = z
  .object({
    /** The credential that signed, base64url, as the authenticator reports it. */
    credentialId: base64url,
    /** The authenticator data, base64url, exactly as signed. */
    authenticatorData: base64url,
    /** The client data JSON, base64url, exactly as signed: it holds the challenge and the origin. */
    clientDataJSON: base64url,
    /** The signature over the authenticator data and the SHA-256 of the client data, base64url. */
    signature: base64url,
    /**
     * The challenge the device signed: the SHA-256, base64url, of the canonical JSON of the mandate's
     * policy hash and readback hash with the nonce and expiry below.
     */
    challenge: base64url,
    /** The nonce Behest issued for this signature. */
    nonce: base64url,
    /** When the chance to sign ended, in whole seconds since the epoch. */
    exp: z.number().int().nonnegative(),
  })
  .strict();
export type BuyerAssertion = z.infer<typeof BuyerAssertion>;
