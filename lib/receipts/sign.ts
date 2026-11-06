import { CompactSign, compactVerify, createLocalJWKSet, errors, type JWK } from 'jose';
import type { z } from 'zod';
import { canonicalJson } from './canonical';
import { type loadSigningKey, publicJwks } from './keys';

const ALG = 'EdDSA';

/** The `typ` header of each signed artifact, so that one kind never passes as the other. */
export type JwsType = 'behest-mandate+jws' | 'behest-receipt+jws';

export interface Signer {
  /** Signs the canonical JSON of `payload` as a compact JWS whose header names the key and type. */
  sign(payload: object, typ: JwsType): Promise<string>;
  /** The public key set that verifies this signer's output. */
  jwks(): Promise<{ keys: JWK[] }>;
}

export function createSigner(key: Awaited<ReturnType<typeof loadSigningKey>>): Signer {
  return {
    sign: (payload, typ) =>
      new CompactSign(new TextEncoder().encode(canonicalJson(payload)))
        .setProtectedHeader({ alg: ALG, kid: key.kid, typ })
        .sign(key.privateKey),
    jwks: async () => publicJwks([key]),
  };
}

export type VerifyErrorCode = 'bad_signature' | 'wrong_type' | 'unknown_key' | 'malformed';

const MESSAGES: Record<VerifyErrorCode, string> = {
  bad_signature: 'the JWS signature does not verify',
  wrong_type: 'the JWS is not of the expected type',
  unknown_key: 'the JWS does not name a key in the public key set',
  malformed: 'the JWS or its payload is malformed',
};

export class VerifyError extends Error {
  readonly code: VerifyErrorCode;
  constructor(code: VerifyErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'VerifyError';
    this.code = code;
  }
}

/**
 * Verifies a compact JWS against a public key set (built with `publicJwks`) and returns its
 * payload parsed by `schema`. The algorithm is pinned to EdDSA whatever the header says, and the
 * type is checked only once the signature holds, so `wrong_type` always means an authentic JWS
 * of the other kind. Every failure is a VerifyError; the underlying error is kept as its cause.
 */
export async function verifyJws<T>(jws: string, typ: JwsType, jwks: { keys: JWK[] }, schema: z.ZodType<T>): Promise<T> {
  try {
    const keySet = createLocalJWKSet(jwks);
    const { payload, protectedHeader } = await compactVerify(
      jws,
      (header, token) => {
        // Without a kid the key set would match any key it holds. A Behest JWS always names its key.
        if (header.kid === undefined) throw new VerifyError('unknown_key');
        return keySet(header, token);
      },
      { algorithms: [ALG] },
    );
    if (protectedHeader.typ !== typ) throw new VerifyError('wrong_type');
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)));
  } catch (error) {
    if (error instanceof VerifyError) throw error;
    throw new VerifyError(codeFor(error), { cause: error });
  }
}

function codeFor(error: unknown): VerifyErrorCode {
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  // Any alg other than EdDSA is refused before a key is chosen: such a JWS cannot carry a Behest
  // signature, whether it says none or HS256 to pass the public key off as an HMAC secret.
  if (error instanceof errors.JOSEAlgNotAllowed) return 'bad_signature';
  if (error instanceof errors.JWKSNoMatchingKey) return 'unknown_key';
  // Everything else is malformed: a JWS that does not parse, a payload that is not UTF-8 JSON or
  // fails the schema, or a key set that is not one.
  return 'malformed';
}
