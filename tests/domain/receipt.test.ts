import { expect, it } from 'vitest';
import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';

const hash = 'a'.repeat(64);

const receipt = {
  v: 1,
  id: '6f1c2b8e-3d4a-4f5b-9c6d-7e8f9a0b1c2d',
  iss: 'behest',
  iat: 1793955600,
  mandate: { id: 'm1', policyHash: hash, jwsHash: hash },
  seller: { slug: 'ravi-spices' },
  cart: { hash, totalCents: 1275, currency: 'USD', itemCount: 2 },
  decision: {
    purchaseId: 'p1',
    verdict: 'ALLOW',
    approver: 'policy',
    rulesetVersion: 'gate-v1',
    outcomes: [{ rule: 'mandate_active', result: 'pass' }],
  },
  payment: {
    processor: 'paypal',
    orderId: 'ORDER-1',
    captureId: 'CAPTURE-1',
    amountCents: 1275,
    capturedAt: '2026-11-06T10:00:00Z',
  },
};

const mandate = {
  v: 1,
  id: 'm1',
  iss: 'behest',
  iat: 1793955600,
  buyer: { ref: hash },
  policyHash: hash,
  readbackHash: hash,
  confirmedAt: '2026-11-06T09:00:00Z',
  confirmation: 'session',
  expiresAt: null,
};

it('accepts a receipt payload', () => expect(ReceiptPayload.safeParse(receipt).success).toBe(true));

it("accepts a receipt that carries the hash of the agent's decision record", () => {
  expect(ReceiptPayload.safeParse({ ...receipt, agent: { decisionHash: hash } }).success).toBe(true);
});

it.each([
  ['a BLOCK verdict', { ...receipt, decision: { ...receipt.decision, verdict: 'BLOCK' } }],
  ['a receipt id that is not a uuid', { ...receipt, id: 'r1' }],
  ['a capture time that is not ISO', { ...receipt, payment: { ...receipt.payment, capturedAt: 'yesterday' } }],
  ['a cart hash that is not sha256 hex', { ...receipt, cart: { ...receipt.cart, hash: 'abc' } }],
  ['an outcome with extra fields', { ...receipt, decision: { ...receipt.decision, outcomes: [{ rule: 'velocity', result: 'pass', detail: 'x' }] } }],
  ['no rule outcomes', { ...receipt, decision: { ...receipt.decision, outcomes: [] } }],
  ['unknown keys', { ...receipt, note: 'x' }],
  ['a decision hash that is not sha256 hex', { ...receipt, agent: { decisionHash: 'abc' } }],
  ['an agent claim with unknown keys', { ...receipt, agent: { decisionHash: hash, model: 'x' } }],
])('rejects a receipt with %s', (_, input) => expect(ReceiptPayload.safeParse(input).success).toBe(false));

it('accepts a mandate payload with or without an expiry', () => {
  expect(MandatePayload.safeParse(mandate).success).toBe(true);
  expect(MandatePayload.safeParse({ ...mandate, expiresAt: '2026-12-31T23:59:59Z' }).success).toBe(true);
});

/** The buyer's passkey as a passkey-confirmed mandate names it. */
const passkey = { credentialId: 'Y3JlZGVudGlhbA', publicKey: 'cHVibGljLWtleQ', alg: -7 };

it("accepts a mandate confirmed by the buyer's passkey, naming the passkey", () => {
  expect(MandatePayload.safeParse({ ...mandate, confirmation: 'passkey', passkey }).success).toBe(true);
});

it.each([
  ['another confirmation method', { ...mandate, confirmation: 'email' }],
  ['a confirmation time that is not ISO', { ...mandate, confirmedAt: 'today' }],
  ['unknown keys', { ...mandate, policy: {} }],
  ['a passkey confirmation that names no passkey', { ...mandate, confirmation: 'passkey' }],
  ['a session confirmation that names a passkey', { ...mandate, passkey }],
  ['a passkey with unknown keys', { ...mandate, confirmation: 'passkey', passkey: { ...passkey, counter: 1 } }],
  ['a passkey algorithm that is not a number', { ...mandate, confirmation: 'passkey', passkey: { ...passkey, alg: 'ES256' } }],
  ['a passkey with no public key', { ...mandate, confirmation: 'passkey', passkey: { ...passkey, publicKey: '' } }],
])('rejects a mandate with %s', (_, input) => expect(MandatePayload.safeParse(input).success).toBe(false));
