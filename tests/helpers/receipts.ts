import { Cart } from '@/lib/domain/cart';
import type { ReceiptPayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';

// Signed receipts for seller intake tests: Behest's key and key set, a foreign key, a cart from the
// demo seller and a receipt for it.

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });

/** Behest's public key set in these tests. */
export const receiptJwks = publicJwks([key]);

/** Signs a payload as a receipt under Behest's key. */
export const signReceipt = (payload: object) => createSigner(key).sign(payload, 'behest-receipt+jws');

const foreignKey = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });

/** Signs a payload as a receipt under a key outside Behest's key set. */
export const forgeReceipt = (payload: object) => createSigner(foreignKey).sign(payload, 'behest-receipt+jws');

/** When the receipts are issued, unless a test says otherwise. */
export const RECEIPT_ISSUED = new Date('2026-11-06T10:00:00Z');

// Two lines, three units: 900 + 2 * 375 = 1650 cents.
export const raviCart = Cart.parse({
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [
    { sku: 'SAF-1G', title: 'Kashmiri Saffron, 1 g', category: 'spices', unitPriceCents: 900, quantity: 1 },
    { sku: 'CUM-100', title: 'Whole Cumin Seeds, 100 g', category: 'spices', unitPriceCents: 375, quantity: 2 },
  ],
  totalCents: 1650,
});

/** A receipt for `cart`, issued at `issued`, with a fresh receipt id. */
export function receiptFor(cart: Cart, issued = RECEIPT_ISSUED): ReceiptPayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: issued.getTime() / 1000,
    mandate: {
      id: crypto.randomUUID(),
      policyHash: hashOf({ categories: ['spices'], maxCents: 6000 }),
      jwsHash: sha256Hex('header.payload.signature'),
    },
    seller: { slug: cart.seller.slug },
    cart: {
      hash: hashOf(cart),
      totalCents: cart.totalCents,
      currency: 'USD',
      itemCount: cart.items.reduce((units, item) => units + item.quantity, 0),
    },
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
      amountCents: cart.totalCents,
      capturedAt: issued.toISOString(),
    },
  };
}
