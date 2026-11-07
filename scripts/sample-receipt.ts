import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CatalogEntry } from '../lib/gate/evaluate';
import { evaluateGate } from '../lib/gate/evaluate';
import { MandatePayload, ReceiptPayload } from '../lib/domain/receipt';
import type { MandatePolicy } from '../lib/domain/policy';
import { hashOf, sha256Hex } from '../lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '../lib/receipts/keys';
import { createSigner } from '../lib/receipts/sign';
import { cartClaims } from '../lib/receipts/verify-receipt';

// Writes lib/demo/sample-receipt.json: a signed mandate and a signed receipt for the landing page
// to show, made by the real gate, cart hashing and signer with a throwaway key. The key lives only
// in memory while this runs; the file holds the two tokens and the public key set that verifies
// them, never the private key. The purchase is a sample: Ravi's spice gift box at $40.00, over the
// $25 the buyer approves themselves, approved at PayPal. The PayPal ids are placeholders.
//
// Run with `npx tsx scripts/sample-receipt.ts`. Each run makes a new key, so the tokens change.

const NOW = new Date('2026-11-07T14:02:11.000Z');
const CONFIRMED = new Date('2026-11-01T09:30:00.000Z');

const policy: MandatePolicy = {
  version: 1,
  currency: 'USD',
  budget: { amountCents: 6000, period: 'month' },
  perPurchaseMaxCents: 6000,
  askAboveCents: 2500,
  categories: { allow: ['groceries', 'spices'], deny: ['electronics'] },
  merchants: { allow: null, deny: [] },
  velocity: null,
  expiresAt: null,
};

const readback = [
  'Spend up to $60.00 a month.',
  'Ask me before any purchase over $25.00.',
  'Only groceries and spices, never electronics.',
];

const giftBox: CatalogEntry = {
  sku: 'GIFT-SET',
  title: 'Spice gift box',
  category: 'spices',
  priceCents: 4000,
  stock: 10,
  flags: [],
  marketMedianCents: null,
};

async function main() {
  const { pem } = await generateSigningKey();
  const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: pem });
  const signer = createSigner(key);

  const mandateId = '5c1e9a7d-3b2f-4e61-9d08-2a7f4c6b1e30';
  const mandate = MandatePayload.parse({
    v: 1,
    id: mandateId,
    iss: 'behest',
    iat: Math.floor(CONFIRMED.getTime() / 1000),
    buyer: { ref: sha256Hex('sample-buyer') },
    policyHash: hashOf(policy),
    readbackHash: hashOf(readback),
    confirmedAt: CONFIRMED.toISOString(),
    confirmation: 'session',
    expiresAt: null,
  });
  const mandateJws = await signer.sign(mandate, 'behest-mandate+jws');

  const gate = evaluateGate({
    policy,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
    proposal: { sellerSlug: 'ravi-spices', items: [{ sku: 'GIFT-SET', quantity: 1 }], rationale: 'A gift box of spices.' },
    catalog: new Map([[giftBox.sku, giftBox]]),
    spentInPeriodCents: 1875,
    recentPurchaseTimes: [],
    now: NOW,
  });
  if (gate.verdict !== 'ASK' || !gate.cart) throw new Error(`the sample purchase should be asked about, not ${gate.verdict}`);

  const receipt = ReceiptPayload.parse({
    v: 1,
    id: '0f8e6a1c-52d4-4f27-9a3b-7c1de0b4e21b',
    iss: 'behest',
    iat: Math.floor(NOW.getTime() / 1000),
    mandate: { id: mandateId, policyHash: mandate.policyHash, jwsHash: sha256Hex(mandateJws) },
    seller: { slug: 'ravi-spices' },
    cart: cartClaims(gate.cart),
    decision: {
      purchaseId: 'b7d2f0c4-1e2a-4c55-8d0e-6a9f3b1c2d4e',
      verdict: 'ASK',
      approver: 'human',
      rulesetVersion: gate.rulesetVersion,
      outcomes: gate.outcomes.map(({ rule, result }) => ({ rule, result })),
    },
    payment: {
      processor: 'paypal',
      orderId: '8MC58745YK1234567',
      captureId: '3GG27975UR7654321',
      amountCents: gate.cart.totalCents,
      capturedAt: NOW.toISOString(),
    },
  });
  const receiptJws = await signer.sign(receipt, 'behest-receipt+jws');

  const file = path.join(import.meta.dirname, '..', 'lib', 'demo', 'sample-receipt.json');
  const sample = {
    note: 'A sample for the landing page, signed with a throwaway key by scripts/sample-receipt.ts. Not a real purchase.',
    mandateJws,
    receiptJws,
    jwks: publicJwks([key]),
    cart: gate.cart,
    outcomes: gate.outcomes,
  };
  writeFileSync(file, `${JSON.stringify(sample, null, 2)}\n`);
  console.log(`Wrote ${path.relative(process.cwd(), file)} with key ${key.kid}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
