import { describe, expect, it } from 'vitest';
import { decodeReceipt, receiptClaims, verifyReceipt } from '@/lib/dashboard/receipt';
import type { Cart } from '@/lib/domain/cart';
import type { ReceiptPayload } from '@/lib/domain/receipt';
import { fakeFetch } from '@/tests/helpers/fake-fetch';

const ENDPOINT = 'http://localhost/api/receipts/verify';

const payload: ReceiptPayload = {
  v: 1,
  id: '0f8e3a52-6c1d-4b5e-9a7f-2d3c4b5a6e7f',
  iss: 'behest',
  iat: 1_793_964_005,
  mandate: { id: 'mandate-7', policyHash: 'b'.repeat(64), jwsHash: 'c'.repeat(64) },
  seller: { slug: 'ravi-spices' },
  cart: { hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', totalCents: 1875, currency: 'USD', itemCount: 3 },
  decision: {
    purchaseId: 'purchase-1',
    verdict: 'ALLOW',
    approver: 'policy',
    rulesetVersion: 'gate-v1',
    outcomes: [
      { rule: 'mandate_active', result: 'pass' },
      { rule: 'cart_valid', result: 'pass' },
      { rule: 'price_benchmark', result: 'skip' },
    ],
  },
  payment: {
    processor: 'paypal',
    orderId: '5O190127TN364715T',
    captureId: '3C679366HH908993F',
    amountCents: 1875,
    capturedAt: '2026-11-06T11:20:00.000Z',
  },
};

const cart: Cart = {
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [{ sku: 'TUR-100', title: 'Turmeric', category: 'spices', unitPriceCents: 625, quantity: 3 }],
  totalCents: 1875,
};

const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
const jwsOf = (body: object, header: object = { alg: 'EdDSA', kid: 'behest-2026-11' }) =>
  `${encode(header)}.${encode(body)}.c2lnbmF0dXJl`;

describe('decodeReceipt', () => {
  it('reads the key id and payload without checking the signature', () => {
    expect(decodeReceipt(jwsOf(payload))).toEqual({ keyId: 'behest-2026-11', algorithm: 'EdDSA', payload });
  });

  it('gives null for anything that is not a readable receipt', () => {
    expect(decodeReceipt('not-a-jws')).toBeNull();
    expect(decodeReceipt(jwsOf({ ...payload, iss: 'someone-else' }))).toBeNull();
  });
});

describe('receiptClaims', () => {
  it('lists the claims a seller checks against its cart, then the claims carried under the signature', () => {
    const claims = receiptClaims({ keyId: 'behest-2026-11', algorithm: 'EdDSA', payload });
    expect(claims).toEqual([
      { kind: 'checked', label: 'Signature', value: 'EdDSA, key behest-2026-11' },
      { kind: 'checked', label: 'Seller', value: 'ravi-spices' },
      { kind: 'checked', label: 'Cart', value: '3 items, hash 9f86d081...0f00a08' },
      { kind: 'checked', label: 'Amount', value: '$18.75 paid for a $18.75 cart' },
      { kind: 'signed', label: 'Decision', value: 'ALLOW, approved by the policy under gate-v1' },
      { kind: 'signed', label: 'Rules', value: '3 rules: 2 passed, 1 skipped' },
      { kind: 'signed', label: 'Mandate', value: 'mandate-7, policy hash bbbbbbbb...bbbbbbb' },
      { kind: 'signed', label: 'Payment', value: 'PayPal capture 3C679366HH908993F on 6 Nov 2026, 11:20 UTC' },
      { kind: 'signed', label: 'Issued', value: 'by behest on 6 Nov 2026, 11:20 UTC' },
    ]);
  });

  it('names the buyer as approver and counts asks for an ASK purchase', () => {
    const ask: ReceiptPayload = {
      ...payload,
      decision: {
        ...payload.decision,
        verdict: 'ASK',
        approver: 'human',
        outcomes: [
          { rule: 'mandate_active', result: 'pass' },
          { rule: 'ask_threshold', result: 'ask' },
        ],
      },
    };
    const claims = receiptClaims({ keyId: null, algorithm: null, payload: ask });
    expect(claims.find((c) => c.label === 'Decision')?.value).toBe('ASK, approved by the buyer under gate-v1');
    expect(claims.find((c) => c.label === 'Rules')?.value).toBe('2 rules: 1 passed, 1 asked');
    expect(claims.find((c) => c.label === 'Signature')?.value).toBe('No algorithm, no key id');
  });
});

describe('verifyReceipt', () => {
  const input = { jws: jwsOf(payload), cart, sellerSlug: 'ravi-spices' };

  it('posts the receipt, cart and seller slug as JSON and reports a verified payload', async () => {
    const { fetch, calls } = fakeFetch([{ method: 'POST', path: '/api/receipts/verify', body: { ok: true, payload } }]);
    expect(await verifyReceipt(input, { fetch, endpoint: ENDPOINT })).toEqual({ state: 'verified', payload });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? '')).toEqual(input);
  });

  it.each([200, 422])('reports the reason when the verifier rejects the receipt with %i', async (status) => {
    const { fetch } = fakeFetch([
      { method: 'POST', path: '/api/receipts/verify', status, body: { ok: false, reason: 'cart hash does not match' } },
    ]);
    expect(await verifyReceipt(input, { fetch, endpoint: ENDPOINT })).toEqual({
      state: 'rejected',
      reason: 'cart hash does not match',
    });
  });

  it('reports verification as unavailable when the verifier route does not exist', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', path: '/api/receipts/verify', status: 404, body: { ok: false, reason: 'x' } }]);
    expect(await verifyReceipt(input, { fetch, endpoint: ENDPOINT })).toEqual({
      state: 'unavailable',
      message: 'The receipt verifier is not available on this server.',
    });
  });

  it('reports verification as unavailable when the verifier fails or cannot be reached', async () => {
    const failing = fakeFetch([{ method: 'POST', path: '/api/receipts/verify', status: 500, body: 'boom' }]);
    expect(await verifyReceipt(input, { fetch: failing.fetch, endpoint: ENDPOINT })).toEqual({
      state: 'unavailable',
      message: 'The receipt verifier answered with status 500.',
    });

    const unreachable = fakeFetch([]);
    expect(await verifyReceipt(input, { fetch: unreachable.fetch, endpoint: ENDPOINT })).toEqual({
      state: 'unavailable',
      message: 'The receipt verifier could not be reached.',
    });
  });

  it('does not trust a success answer whose payload is not a receipt', async () => {
    const { fetch } = fakeFetch([{ method: 'POST', path: '/api/receipts/verify', body: { ok: true, payload: { id: 'x' } } }]);
    expect(await verifyReceipt(input, { fetch, endpoint: ENDPOINT })).toEqual({
      state: 'unavailable',
      message: 'The receipt verifier answered with something other than a receipt.',
    });
  });
});
