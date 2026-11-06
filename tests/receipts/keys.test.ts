import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { CompactSign, compactVerify, createLocalJWKSet } from 'jose';
import { expect, it, vi } from 'vitest';
import { sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';

// Passes through to node:crypto, except that one test sets `derivePublicKeyFrom` so the public key
// derived while loading belongs to a different key pair than the private key.
const swap = vi.hoisted(() => ({ derivePublicKeyFrom: undefined as string | undefined }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createPublicKey: (key: Parameters<typeof actual.createPublicKey>[0]) =>
      actual.createPublicKey(swap.derivePublicKeyFrom ?? key),
  };
});

it('generates a key that loads as a non-extractable Ed25519 private key', async () => {
  const { pem, kid } = await generateSigningKey();
  const loaded = await loadSigningKey({ RECEIPT_SIGNING_KEY: pem, RECEIPT_KEY_ID: kid });
  expect(loaded.kid).toBe(kid);
  expect(loaded.privateKey.type).toBe('private');
  expect(loaded.privateKey.algorithm.name).toBe('Ed25519');
  expect(loaded.privateKey.extractable).toBe(false);
});

it('derives the key id from the RFC 7638 thumbprint of the public key', async () => {
  const { pem, kid } = await generateSigningKey();
  const { x } = createPublicKey(pem).export({ format: 'jwk' });
  const thumbprint = createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
  expect(kid).toMatch(/^[0-9a-f]{16}$/);
  expect(kid).toBe(sha256Hex(thumbprint).slice(0, 16));
});

it('publishes the public key with its algorithm, use and key id and no private member', async () => {
  const { pem, kid } = await generateSigningKey();
  const jwks = publicJwks([await loadSigningKey({ RECEIPT_SIGNING_KEY: pem })]);
  expect(jwks.keys).toEqual([{ kty: 'OKP', crv: 'Ed25519', x: expect.any(String), alg: 'EdDSA', use: 'sig', kid }]);
  expect(jwks.keys[0]).not.toHaveProperty('d');
});

it('never publishes a private member even when handed a private JWK', () => {
  const jwks = publicJwks([{ publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'public', d: 'secret' }, kid: 'k1' }]);
  expect(jwks.keys[0]).not.toHaveProperty('d');
  expect(JSON.stringify(jwks)).not.toContain('secret');
});

it('signs with the loaded key so that its published entry verifies the signature', async () => {
  const { pem } = await generateSigningKey();
  const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: pem });
  const jws = await new CompactSign(new TextEncoder().encode('{"a":1}'))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid })
    .sign(key.privateKey);
  const { payload } = await compactVerify(jws, createLocalJWKSet(publicJwks([key])));
  expect(new TextDecoder().decode(payload)).toBe('{"a":1}');
});

it('refuses to load without RECEIPT_SIGNING_KEY', async () => {
  await expect(loadSigningKey({})).rejects.toThrow('missing RECEIPT_SIGNING_KEY');
  await expect(loadSigningKey({ RECEIPT_SIGNING_KEY: '' })).rejects.toThrow('missing RECEIPT_SIGNING_KEY');
});

it('treats a blank RECEIPT_SIGNING_KEY as missing', async () => {
  for (const value of ['   ', ' \n\t ', '\\n\\n']) {
    await expect(loadSigningKey({ RECEIPT_SIGNING_KEY: value })).rejects.toThrow('missing RECEIPT_SIGNING_KEY');
  }
});

it('loads a PEM whose newlines are written as literal \\n, as in a .env file', async () => {
  const { pem, kid } = await generateSigningKey();
  const escaped = pem.replaceAll('\n', '\\n');
  expect(escaped).not.toContain('\n');
  expect((await loadSigningKey({ RECEIPT_SIGNING_KEY: escaped })).kid).toBe(kid);
});

async function loadError(env: { RECEIPT_SIGNING_KEY?: string; RECEIPT_KEY_ID?: string }): Promise<string> {
  const error = await loadSigningKey(env).then(
    () => expect.unreachable('the key loaded'),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

it('refuses a RECEIPT_KEY_ID that does not match the key, naming both ids', async () => {
  const { pem, kid } = await generateSigningKey();
  const other = await generateSigningKey();
  expect(await loadError({ RECEIPT_SIGNING_KEY: pem, RECEIPT_KEY_ID: other.kid })).toBe(
    `RECEIPT_KEY_ID ${other.kid} does not match the signing key, whose id is ${kid}`,
  );
});

it('refuses a RECEIPT_KEY_ID that is not a key id without echoing it', async () => {
  const { pem } = await generateSigningKey();
  for (const value of ['not-a-key-id', 'ABCDEF0123456789', 'abcdef01234567890']) {
    expect(await loadError({ RECEIPT_SIGNING_KEY: pem, RECEIPT_KEY_ID: value })).toBe('RECEIPT_KEY_ID is not a key id');
  }
});

it('never puts a private key pasted into RECEIPT_KEY_ID into the error', async () => {
  const { pem } = await generateSigningKey();
  const body = pem.split('\n')[1];
  for (const value of [pem, pem.replaceAll('\n', '\\n')]) {
    const message = await loadError({ RECEIPT_SIGNING_KEY: pem, RECEIPT_KEY_ID: value });
    expect(message).not.toContain('PRIVATE KEY');
    expect(message).not.toContain(body);
  }
});

it('refuses a RECEIPT_SIGNING_KEY that is not an Ed25519 PKCS8 private key', async () => {
  const { privateKey: p256 } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  for (const value of [p256, 'not a key']) {
    await expect(loadSigningKey({ RECEIPT_SIGNING_KEY: value })).rejects.toThrow(
      'RECEIPT_SIGNING_KEY is not an Ed25519 private key in PKCS8 PEM form',
    );
  }
});

it('refuses a PEM flattened onto one line with the same clear error', async () => {
  const { pem } = await generateSigningKey();
  for (const value of [pem.replaceAll('\n', ''), pem.replaceAll('\n', ' ')]) {
    expect(await loadError({ RECEIPT_SIGNING_KEY: value })).toBe(
      'RECEIPT_SIGNING_KEY is not an Ed25519 private key in PKCS8 PEM form',
    );
  }
});

it('refuses a key whose derived public key does not verify its signatures', async () => {
  const { pem } = await generateSigningKey();
  swap.derivePublicKeyFrom = (await generateSigningKey()).pem;
  try {
    expect(await loadError({ RECEIPT_SIGNING_KEY: pem })).toBe(
      'RECEIPT_SIGNING_KEY failed its self-check: its public key does not verify its signature',
    );
  } finally {
    swap.derivePublicKeyFrom = undefined;
  }
});
