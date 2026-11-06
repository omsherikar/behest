import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { CompactSign } from 'jose';
import { expect, it, vi } from 'vitest';
import { Cart } from '@/lib/domain/cart';
import type { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import { canonicalJson, hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { cartClaims, type ReceiptRejection, verifyReceipt } from '@/lib/receipts/verify-receipt';

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const jwks = publicJwks([key]);
const foreignKey = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });

const ISSUED_AT = Date.parse('2026-11-06T10:00:00Z') / 1000;
const NOW = new Date('2026-11-06T10:05:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Two lines, three units: 900 + 2 * 375 = 1650 cents.
const cart = Cart.parse({
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [
    { sku: 'SAF-01', title: 'Saffron, 1 g', category: 'spices', unitPriceCents: 900, quantity: 1 },
    { sku: 'CUM-02', title: 'Cumin seeds, 100 g', category: 'spices', unitPriceCents: 375, quantity: 2 },
  ],
  totalCents: 1650,
});

function receiptFor(c: Cart): ReceiptPayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: ISSUED_AT,
    mandate: {
      id: crypto.randomUUID(),
      policyHash: hashOf({ categories: ['spices'], maxCents: 10000 }),
      jwsHash: sha256Hex('header.payload.signature'),
    },
    seller: { slug: c.seller.slug },
    cart: { hash: hashOf(c), totalCents: c.totalCents, currency: 'USD', itemCount: 3 },
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
      amountCents: c.totalCents,
      capturedAt: '2026-11-06T10:00:00Z',
    },
  };
}

const sign = (payload: object) => signer.sign(payload, 'behest-receipt+jws');

type Input = Parameters<typeof verifyReceipt>[0];

/** Verifies as the seller `ravi-spices` holding `cart`, five minutes after issue, with no receipt seen before. */
function verify(jws: string, overrides: Partial<Omit<Input, 'jws'>> = {}) {
  return verifyReceipt({ jws, cart, sellerSlug: 'ravi-spices', jwks, now: NOW, seen: async () => false, ...overrides });
}

const rejected = (reason: ReceiptRejection) => ({ ok: false, reason });

it('accepts a valid receipt and returns its payload, checking the payload id for replay', async () => {
  const payload = receiptFor(cart);
  const seen = vi.fn(async () => false);
  expect(await verify(await sign(payload), { seen })).toEqual({ ok: true, payload });
  expect(seen).toHaveBeenCalledExactlyOnceWith(payload.id);
});

it('rejects a receipt signed by a key outside the public key set as bad_signature', async () => {
  const payload = receiptFor(cart);
  const underItsOwnKid = await createSigner(foreignKey).sign(payload, 'behest-receipt+jws');
  const underOurKid = await new CompactSign(new TextEncoder().encode(canonicalJson(payload)))
    .setProtectedHeader({ alg: 'EdDSA', kid: key.kid, typ: 'behest-receipt+jws' })
    .sign(foreignKey.privateKey);
  for (const jws of [underItsOwnKid, underOurKid]) {
    expect(await verify(jws)).toEqual(rejected('bad_signature'));
  }
});

it('rejects a receipt whose payload was edited after signing as bad_signature', async () => {
  const [header, payload, signature] = (await sign(receiptFor(cart))).split('.');
  const edited = Buffer.from(payload, 'base64url').toString('utf8').replace('"slug":"ravi-spices"', '"slug":"other"');
  const jws = [header, Buffer.from(edited).toString('base64url'), signature].join('.');
  expect(await verify(jws, { sellerSlug: 'other' })).toEqual(rejected('bad_signature'));
});

it('rejects a signed mandate, a signed payload that is not a receipt, and a non-JWS as malformed', async () => {
  const mandate: MandatePayload = {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: ISSUED_AT,
    buyer: { ref: sha256Hex('buyer') },
    policyHash: hashOf({ categories: ['spices'] }),
    readbackHash: sha256Hex('Spend up to $100 a month on spices.'),
    confirmedAt: '2026-11-06T09:00:00Z',
    confirmation: 'session',
    expiresAt: null,
  };
  for (const jws of [
    await signer.sign(mandate, 'behest-mandate+jws'),
    await sign({ ...receiptFor(cart), note: 'pay twice' }),
    'not-a-jws',
    '',
  ]) {
    expect(await verify(jws)).toEqual(rejected('malformed'));
  }
});

it('rejects input that makes verification throw as malformed', async () => {
  const jws = await sign(receiptFor(cart));
  expect(await verify(jws, { cart: null as unknown as Cart })).toEqual(rejected('malformed'));
  expect(await verify(jws, { jwks: { keys: 'none' } as unknown as typeof jwks })).toEqual(rejected('malformed'));
});

it('rejects a receipt 16 minutes after issue as expired, and accepts it at exactly 15', async () => {
  const jws = await sign(receiptFor(cart));
  const issued = ISSUED_AT * SECOND;
  expect(await verify(jws, { now: new Date(issued + 16 * MINUTE) })).toEqual(rejected('expired'));
  expect(await verify(jws, { now: new Date(issued + 15 * MINUTE + SECOND) })).toEqual(rejected('expired'));
  expect(await verify(jws, { now: new Date(issued + 15 * MINUTE) })).toMatchObject({ ok: true });
});

it('rejects a receipt issued more than a minute in the future as expired', async () => {
  const jws = await sign(receiptFor(cart));
  const issued = ISSUED_AT * SECOND;
  expect(await verify(jws, { now: new Date(issued - MINUTE - SECOND) })).toEqual(rejected('expired'));
  expect(await verify(jws, { now: new Date(issued - MINUTE) })).toMatchObject({ ok: true });
});

it('rejects every receipt as expired when the clock reading is not a time', async () => {
  expect(await verify(await sign(receiptFor(cart)), { now: new Date(Number.NaN) })).toEqual(rejected('expired'));
});

it('rejects a receipt presented to another seller as wrong_seller', async () => {
  expect(await verify(await sign(receiptFor(cart)), { sellerSlug: 'other' })).toEqual(rejected('wrong_seller'));
});

it('rejects a cart addressed to another seller as wrong_seller, even when the receipt names this one', async () => {
  const otherCart = Cart.parse({ ...cart, seller: { slug: 'other', name: 'Other' } });
  const payload = { ...receiptFor(otherCart), seller: { slug: 'ravi-spices' } };
  expect(await verify(await sign(payload), { cart: otherCart })).toEqual(rejected('wrong_seller'));
});

it('rejects a cart with one quantity changed as cart_mismatch', async () => {
  const jws = await sign(receiptFor(cart));
  const changed = Cart.parse({
    ...cart,
    items: [cart.items[0], { ...cart.items[1], quantity: 3 }],
    totalCents: 900 + 3 * 375,
  });
  expect(await verify(jws, { cart: changed })).toEqual(rejected('cart_mismatch'));
});

it('rejects a receipt whose item count or cart total disagrees with the cart as cart_mismatch', async () => {
  const payload = receiptFor(cart);
  for (const claims of [
    // The item count is the number of units, three here, not the number of lines.
    { ...payload.cart, itemCount: 2 },
    { ...payload.cart, totalCents: 1651 },
  ]) {
    expect(await verify(await sign({ ...payload, cart: claims }))).toEqual(rejected('cart_mismatch'));
  }
});

it('rejects a payment amount that differs from the cart total as amount_mismatch', async () => {
  const payload = receiptFor(cart);
  const jws = await sign({ ...payload, payment: { ...payload.payment, amountCents: 1649 } });
  expect(await verify(jws)).toEqual(rejected('amount_mismatch'));
});

it('rejects a receipt seen before as replayed', async () => {
  expect(await verify(await sign(receiptFor(cart)), { seen: async () => true })).toEqual(rejected('replayed'));
});

it('reports the first failing check in the order of the rejection type, and asks about replay last', async () => {
  const good = receiptFor(cart);
  let payload: ReceiptPayload = {
    ...good,
    iat: ISSUED_AT - 60 * 60,
    seller: { slug: 'other' },
    cart: { ...good.cart, hash: sha256Hex('another cart') },
    payment: { ...good.payment, amountCents: 1 },
  };
  const seen = vi.fn(async () => true);

  const forged = await createSigner(foreignKey).sign({ ...payload, note: 'x' }, 'behest-receipt+jws');
  expect(await verify(forged, { seen })).toEqual(rejected('bad_signature'));
  expect(await verify(await sign({ ...payload, note: 'x' }), { seen })).toEqual(rejected('malformed'));

  const fixes: [ReceiptRejection, Partial<ReceiptPayload>][] = [
    ['expired', {}],
    ['wrong_seller', { iat: good.iat }],
    ['cart_mismatch', { seller: good.seller }],
    ['amount_mismatch', { cart: good.cart }],
  ];
  for (const [reason, fix] of fixes) {
    payload = { ...payload, ...fix };
    expect(await verify(await sign(payload), { seen })).toEqual(rejected(reason));
  }
  expect(seen).not.toHaveBeenCalled();

  payload = { ...payload, payment: good.payment };
  expect(await verify(await sign(payload), { seen })).toEqual(rejected('replayed'));
  expect(seen).toHaveBeenCalledExactlyOnceWith(good.id);
});

it('lets a failure of the replay check propagate instead of rejecting the receipt', async () => {
  const failure = new Error('replay store unavailable');
  const jws = await sign(receiptFor(cart));
  await expect(verify(jws, { seen: () => Promise.reject(failure) })).rejects.toBe(failure);
});

it('states the cart claims a receipt makes: hash, total, currency and the number of units', () => {
  expect(cartClaims(cart)).toStrictEqual({ hash: hashOf(cart), totalCents: 1650, currency: 'USD', itemCount: 3 });
});

const ROOT = resolve(import.meta.dirname, '../..');

/** Repo-relative paths of the modules `file` reaches through its imports, itself included. */
function modulesReachedFrom(file: string, reached = new Set<string>()): Set<string> {
  const path = relative(ROOT, file);
  if (reached.has(path)) return reached;
  reached.add(path);
  if (!existsSync(file)) return reached;
  // Static, side-effect and dynamic imports, and re-exports.
  for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const base = specifier.startsWith('@/')
      ? join(ROOT, specifier.slice(2))
      : specifier.startsWith('.')
        ? resolve(dirname(file), specifier)
        : null;
    if (base === null) continue;
    const target = [`${base}.ts`, join(base, 'index.ts')].find((candidate) => existsSync(candidate)) ?? base;
    modulesReachedFrom(target, reached);
  }
  return reached;
}

it('reaches no purchase or database module through its imports', () => {
  const reached = [...modulesReachedFrom(join(ROOT, 'lib/receipts/verify-receipt.ts'))];
  expect(reached).toContain('lib/receipts/sign.ts');
  expect(reached.filter((path) => /^lib\/(db|purchases)\b/.test(path))).toEqual([]);
});
