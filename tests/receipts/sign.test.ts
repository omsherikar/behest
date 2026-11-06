import { CompactSign, type CompactJWSHeaderParameters, decodeProtectedHeader } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import { canonicalJson, hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner, VerifyError, verifyJws } from '@/lib/receipts/sign';

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const jwks = publicJwks([key]);

function receiptPayload(): ReceiptPayload {
  const cart = [{ listingId: crypto.randomUUID(), quantity: 2, unitCents: 2500 }];
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: 1793955600,
    mandate: {
      id: crypto.randomUUID(),
      policyHash: hashOf({ categories: ['spices'], maxCents: 10000 }),
      jwsHash: sha256Hex('header.payload.signature'),
    },
    seller: { slug: 'ravi-spices' },
    cart: { hash: hashOf(cart), totalCents: 5000, currency: 'USD', itemCount: 2 },
    decision: {
      purchaseId: crypto.randomUUID(),
      verdict: 'ALLOW',
      approver: 'policy',
      rulesetVersion: 'gate-v1',
      outcomes: [{ rule: 'mandate_active', result: 'pass' }],
    },
    payment: {
      processor: 'paypal',
      orderId: 'ORDER-1',
      captureId: 'CAPTURE-1',
      amountCents: 5000,
      capturedAt: '2026-11-06T10:00:00Z',
    },
  };
}

function mandatePayload(): MandatePayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: 1793952000,
    buyer: { ref: sha256Hex(crypto.randomUUID()) },
    policyHash: hashOf({ categories: ['spices'], maxCents: 10000 }),
    readbackHash: sha256Hex('Spend up to $100 a month on spices.'),
    confirmedAt: '2026-11-06T09:00:00Z',
    confirmation: 'session',
    expiresAt: null,
  };
}

const base64url = (data: string | Uint8Array) => Buffer.from(data).toString('base64url');

/** Signs arbitrary payload bytes under an arbitrary header with the real signing key. */
function signRaw(payload: string | Uint8Array, header: CompactJWSHeaderParameters): Promise<string> {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  return new CompactSign(bytes).setProtectedHeader(header).sign(key.privateKey);
}

/** The code of the VerifyError the verification rejects with. */
async function rejection(verification: Promise<unknown>): Promise<string> {
  const error = await verification.then(
    () => expect.unreachable('the JWS verified'),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VerifyError);
  return (error as VerifyError).code;
}

it('round trips a receipt and a mandate, returning the parsed payload', async () => {
  const receipt = receiptPayload();
  const receiptJws = await signer.sign(receipt, 'behest-receipt+jws');
  expect(await verifyJws(receiptJws, 'behest-receipt+jws', jwks, ReceiptPayload)).toEqual(receipt);

  const mandate = mandatePayload();
  const mandateJws = await signer.sign(mandate, 'behest-mandate+jws');
  expect(await verifyJws(mandateJws, 'behest-mandate+jws', jwks, MandatePayload)).toEqual(mandate);
});

it('signs the canonical JSON of the payload under exactly the alg, kid and typ header', async () => {
  const receipt = receiptPayload();
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  const jws = await signer.sign(reordered, 'behest-receipt+jws');
  expect(decodeProtectedHeader(jws)).toStrictEqual({ alg: 'EdDSA', kid: key.kid, typ: 'behest-receipt+jws' });
  expect(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8')).toBe(canonicalJson(receipt));
});

it('publishes the public key set that verifies its signatures', async () => {
  expect(await signer.jwks()).toEqual(publicJwks([key]));
});

it('rejects a payload with one character changed as bad_signature', async () => {
  const [header, payload, signature] = (await signer.sign(receiptPayload(), 'behest-receipt+jws')).split('.');
  const text = Buffer.from(payload, 'base64url').toString('utf8');
  const tampered = text.replace('"totalCents":5000', '"totalCents":5001');
  expect(tampered).not.toBe(text);
  const forged = [header, base64url(tampered), signature].join('.');
  expect(await rejection(verifyJws(forged, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('bad_signature');
});

it('rejects a JWS signed by another key under a published kid as bad_signature', async () => {
  const other = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
  const forged = await new CompactSign(new TextEncoder().encode(canonicalJson(receiptPayload())))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'behest-receipt+jws' })
    .sign(other.privateKey);
  expect(await rejection(verifyJws(forged, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('bad_signature');
});

it('rejects a JWS whose alg is not EdDSA as bad_signature, even under a published kid', async () => {
  const typ = 'behest-receipt+jws';
  const payload = canonicalJson(receiptPayload());
  // The published public key used as an HMAC secret, the classic algorithm confusion forgery.
  const secret = new TextEncoder().encode(JSON.stringify(jwks.keys[0]));
  const hs256 = await new CompactSign(new TextEncoder().encode(payload))
    .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ })
    .sign(secret);
  const unsigned = `${base64url(JSON.stringify({ alg: 'none', kid: key.kid, typ }))}.${base64url(payload)}.`;
  for (const jws of [hs256, unsigned]) {
    expect(await rejection(verifyJws(jws, typ, jwks, ReceiptPayload))).toBe('bad_signature');
  }
});

it('rejects a mandate presented as a receipt, and the reverse, as wrong_type', async () => {
  const mandateJws = await signer.sign(mandatePayload(), 'behest-mandate+jws');
  expect(await rejection(verifyJws(mandateJws, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('wrong_type');
  const receiptJws = await signer.sign(receiptPayload(), 'behest-receipt+jws');
  expect(await rejection(verifyJws(receiptJws, 'behest-mandate+jws', jwks, MandatePayload))).toBe('wrong_type');
});

it('rejects a JWS with another typ or none as wrong_type', async () => {
  const payload = canonicalJson(receiptPayload());
  for (const jws of [
    await signRaw(payload, { alg: 'EdDSA', kid: key.kid, typ: 'JWT' }),
    await signRaw(payload, { alg: 'EdDSA', kid: key.kid }),
  ]) {
    expect(await rejection(verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('wrong_type');
  }
});

it('rejects a JWS whose kid is not in the key set as unknown_key', async () => {
  const jws = await signer.sign(receiptPayload(), 'behest-receipt+jws');
  const otherKey = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
  for (const keySet of [publicJwks([otherKey]), { keys: [] }]) {
    expect(await rejection(verifyJws(jws, 'behest-receipt+jws', keySet, ReceiptPayload))).toBe('unknown_key');
  }
});

it('rejects a JWS that names no kid as unknown_key, even when the key set holds one key', async () => {
  const jws = await signRaw(canonicalJson(receiptPayload()), { alg: 'EdDSA', typ: 'behest-receipt+jws' });
  expect(await rejection(verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('unknown_key');
});

it('rejects a signed payload that fails the schema as malformed', async () => {
  const { cart, ...withoutCart } = receiptPayload();
  for (const payload of [{ ...receiptPayload(), note: 'x' }, withoutCart, { cart }]) {
    const jws = await signer.sign(payload, 'behest-receipt+jws');
    expect(await rejection(verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('malformed');
  }
});

it('rejects a signed payload that is not JSON or not UTF-8 as malformed', async () => {
  const header = { alg: 'EdDSA', kid: key.kid, typ: 'behest-receipt+jws' };
  const notUtf8 = new Uint8Array([...new TextEncoder().encode('{"s":"'), 0xff, ...new TextEncoder().encode('"}')]);
  const lenient = z.object({ s: z.string() });
  for (const payload of ['not json', '', notUtf8]) {
    const jws = await signRaw(payload, header);
    expect(await rejection(verifyJws(jws, 'behest-receipt+jws', jwks, lenient))).toBe('malformed');
  }
});

it('rejects input that is not a compact JWS, or a key set that is not one, as malformed', async () => {
  for (const jws of ['', 'not-a-jws', 'a.b', 'a.b.c', '..', 'a.b.c.d']) {
    expect(await rejection(verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload))).toBe('malformed');
  }
  const jws = await signer.sign(receiptPayload(), 'behest-receipt+jws');
  const notAKeySet = { keys: 'none' } as unknown as typeof jwks;
  expect(await rejection(verifyJws(jws, 'behest-receipt+jws', notAKeySet, ReceiptPayload))).toBe('malformed');
});
