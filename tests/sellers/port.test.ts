import { beforeAll, expect, it } from 'vitest';
import { sellers } from '@/lib/db/schema';
import { Cart } from '@/lib/domain/cart';
import type { ReceiptPayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { sellerPort } from '@/lib/sellers/port';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const NOW = new Date('2026-11-06T10:05:00Z');

const cart = Cart.parse({
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [{ sku: 'TUR-100', title: 'Lakadong Turmeric Powder, 100 g', category: 'spices', unitPriceCents: 450, quantity: 2 }],
  totalCents: 900,
});

const receipt: ReceiptPayload = {
  v: 1,
  id: crypto.randomUUID(),
  iss: 'behest',
  iat: Date.parse('2026-11-06T10:00:00Z') / 1000,
  mandate: { id: crypto.randomUUID(), policyHash: hashOf({ maxCents: 6000 }), jwsHash: sha256Hex('mandate') },
  seller: { slug: 'ravi-spices' },
  cart: { hash: hashOf(cart), totalCents: 900, currency: 'USD', itemCount: 2 },
  decision: {
    purchaseId: crypto.randomUUID(),
    verdict: 'ALLOW',
    approver: 'policy',
    rulesetVersion: 'gate-v1',
    outcomes: [{ rule: 'mandate_active', result: 'pass' }],
  },
  payment: { processor: 'paypal', orderId: 'ORDER-1', captureId: 'CAPTURE-1', amountCents: 900, capturedAt: '2026-11-06T10:00:00Z' },
};

it('hands an agent order to the seller and passes on its answer, with the rejection code as the reason', async () => {
  const db = await createTestDb();
  await db.insert(sellers).values({ slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' });
  const port = sellerPort({ db, jwks: async () => publicJwks([key]), now: () => NOW });
  const order = { sellerSlug: 'ravi-spices', cart, receiptJws: await signer.sign(receipt, 'behest-receipt+jws') };

  expect(await port.acceptAgentOrder(order)).toStrictEqual({ status: 'accepted' });
  expect(await port.acceptAgentOrder(order)).toStrictEqual({ status: 'rejected', reason: 'replayed' });
});
