import type { Db } from '@/lib/db/client';
import { buyers, mandates, purchases, sellers, type PurchaseStatus } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { demoPolicy } from '@/tests/helpers/fixtures';

// One purchase and the rows it hangs off, inserted directly so that a test can start the purchase
// at any point of its lifecycle.

const HASH = 'a'.repeat(64);

export const SEEDED_SELLER = { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'payouts@ravi-spices.example.com' };

/** Two jars of turmeric and one of cumin: $18.75. */
export const seededCart: Cart = {
  seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
  currency: 'USD',
  items: [
    { sku: 'TUR-100', title: 'Turmeric, 100 g', category: 'spices', unitPriceCents: 450, quantity: 2 },
    { sku: 'CUM-100', title: 'Cumin, 100 g', category: 'spices', unitPriceCents: 975, quantity: 1 },
  ],
  totalCents: 1875,
};

export type SeededPurchase = { purchaseId: string; buyerId: string; mandateId: string; sellerId: string };

/** A buyer with an active mandate, a seller with a payout email, and an allowed purchase in `status`. */
export async function seedPurchase(db: Db, status: PurchaseStatus): Promise<SeededPurchase> {
  const [buyer] = await db.insert(buyers).values({ name: 'Priya' }).returning();
  const [seller] = await db.insert(sellers).values(SEEDED_SELLER).returning();
  const [mandate] = await db
    .insert(mandates)
    .values({
      buyerId: buyer.id,
      sourceText: '$60 a month on groceries and spices',
      policy: demoPolicy,
      policyHash: HASH,
      readback: ['Up to $60.00 a month.'],
      readbackHash: HASH,
      jws: 'mandate.jws.value',
      confirmedAt: new Date('2026-11-01T09:00:00Z'),
    })
    .returning();
  const [purchase] = await db
    .insert(purchases)
    .values({
      buyerId: buyer.id,
      mandateId: mandate.id,
      sellerId: seller.id,
      request: 'Restock turmeric and cumin',
      proposal: {
        sellerSlug: SEEDED_SELLER.slug,
        items: seededCart.items.map(({ sku, quantity }) => ({ sku, quantity })),
        rationale: 'The buyer asked for turmeric and cumin.',
      },
      cart: seededCart,
      cartHash: HASH,
      totalCents: seededCart.totalCents,
      gateVerdict: 'ALLOW',
      rulesetVersion: 'gate-v1',
      finalVerdict: 'ALLOW',
      approver: 'policy',
      status,
    })
    .returning();
  return { purchaseId: purchase.id, buyerId: buyer.id, mandateId: mandate.id, sellerId: seller.id };
}
