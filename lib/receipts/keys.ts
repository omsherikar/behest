import { createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair, importPKCS8, type JWK } from 'jose';
import { sha256Hex } from './canonical';

const ALG = 'EdDSA';
const KEY_ID = /^[0-9a-f]{16}$/;

/** First 16 hex chars of the SHA-256 of the key's RFC 7638 thumbprint. */
async function keyIdOf(publicJwk: JWK): Promise<string> {
  return sha256Hex(await calculateJwkThumbprint(publicJwk)).slice(0, 16);
}

/** Creates a fresh Ed25519 signing key as PKCS8 PEM, with its key id. */
export async function generateSigningKey(): Promise<{ pem: string; kid: string }> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
  return { pem: await exportPKCS8(privateKey), kid: await keyIdOf(await exportJWK(publicKey)) };
}

/**
 * Loads the signing key from the environment. `RECEIPT_SIGNING_KEY` is a PKCS8 PEM whose newlines
 * may be written as literal `\n`, as they are in .env files. The private key is not extractable,
 * and the public JWK is derived from a public key object, so it holds no private member.
 * When `RECEIPT_KEY_ID` is set it must equal the id derived from the key.
 */
export async function loadSigningKey(env: {
  RECEIPT_SIGNING_KEY?: string;
  RECEIPT_KEY_ID?: string;
}): Promise<{ kid: string; privateKey: CryptoKey; publicJwk: JWK }> {
  const pem = (env.RECEIPT_SIGNING_KEY ?? '').replaceAll('\\n', '\n').trim();
  if (!pem) throw new Error('missing RECEIPT_SIGNING_KEY');

  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(pem, ALG);
  } catch (cause) {
    throw new Error('RECEIPT_SIGNING_KEY is not an Ed25519 private key in PKCS8 PEM form', { cause });
  }

  const publicJwk = await exportJWK(createPublicKey(pem));
  const kid = await keyIdOf(publicJwk);
  const givenKid = env.RECEIPT_KEY_ID;
  if (givenKid && givenKid !== kid) {
    // Echo the value only when it has the shape of a key id: anything else may be a pasted
    // secret, such as the PEM itself, and errors here end up in startup logs.
    if (!KEY_ID.test(givenKid)) throw new Error('RECEIPT_KEY_ID is not a key id');
    throw new Error(`RECEIPT_KEY_ID ${givenKid} does not match the signing key, whose id is ${kid}`);
  }
  return { kid, privateKey, publicJwk };
}

/**
 * The public key set served at /.well-known/jwks.json. Only the public members of each key are
 * copied, so a private JWK passed in by mistake never leaks its `d`.
 */
export function publicJwks(keys: { publicJwk: JWK; kid: string }[]): { keys: JWK[] } {
  return {
    keys: keys.map(({ publicJwk: { kty, crv, x }, kid }) => ({ kty, crv, x, alg: ALG, use: 'sig', kid })),
  };
}
