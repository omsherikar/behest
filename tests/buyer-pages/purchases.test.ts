import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { pendingApprovals } from '@/lib/buyer-pages/purchases';
import type { Db } from '@/lib/db/client';
import { buyers, purchases, type StoredIntentResult, type StoredRuleOutcome } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { purchaseOutcome } from '@/lib/purchases/charge';
import { purchaseRow, SEEDED_SELLER, seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 7, 9, minute));
const APPROVE_URL = 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T';

/** Two grams of saffron: $32.00, over the buyer's $25.00 approval limit. */
const saffronCart: Cart = {
  seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
  currency: 'USD',
  items: [{ sku: 'SAF-1', title: 'Saffron, 1 g', category: 'spices', unitPriceCents: 1600, quantity: 2 }],
  totalCents: 3200,
};
const overLimit: StoredRuleOutcome[] = [
  { rule: 'mandate_active', result: 'pass', detail: 'Your mandate is active.' },
  { rule: 'approval_limit', result: 'ask', detail: 'Over $25.00, so you approve it.' },
];
const unsure: StoredIntentResult = { verdict: 'needs_human', reasons: ['You asked for one gram; the cart has two.'] };

let db: Db;
let buyerId: string;
const ids: Record<'paid' | 'asked' | 'badLink' | 'noLink' | 'unknownSeller' | 'otherBuyer', string> = {
  paid: '',
  asked: '',
  badLink: '',
  noLink: '',
  unknownSeller: '',
  otherBuyer: '',
};

/**
 * Priya with a paid purchase, three waiting for her approval (one with a PayPal link, one with a
 * link that is not PayPal's and one with none yet) and one the gate blocked because the agent named
 * a seller Behest does not know. Another buyer has a purchase waiting for approval too.
 */
beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedPurchase(db, 'captured');
  buyerId = seeded.buyerId;
  ids.paid = seeded.purchaseId;
  const base = await purchaseRow(db, seeded.purchaseId);
  await db.update(purchases).set({ createdAt: at(1) }).where(eq(purchases.id, seeded.purchaseId));

  const copy = { ...base, id: undefined, updatedAt: undefined, approver: null };
  const asked = {
    ...copy,
    cart: saffronCart,
    totalCents: saffronCart.totalCents,
    gateVerdict: 'ASK' as const,
    gateOutcomes: overLimit,
    intent: unsure,
    finalVerdict: 'ASK' as const,
    status: 'awaiting_approval' as const,
  };
  const [other] = await db.insert(buyers).values({ name: 'Arjun' }).returning();
  const inserted = await db
    .insert(purchases)
    .values([
      { ...asked, approveUrl: APPROVE_URL, createdAt: at(2) },
      { ...asked, approveUrl: 'javascript:alert(document.cookie)', createdAt: at(3) },
      { ...asked, approveUrl: null, createdAt: at(4) },
      {
        ...copy,
        sellerId: null,
        proposal: { sellerSlug: 'mystery-mart', items: [{ sku: 'X-1', quantity: 1 }], rationale: 'Cheapest.' },
        cart: null,
        cartHash: null,
        totalCents: null,
        gateVerdict: 'BLOCK' as const,
        gateOutcomes: [{ rule: 'seller_known', result: 'block' as const, detail: 'No Behest seller is called mystery-mart.' }],
        intent: null,
        finalVerdict: null,
        status: 'blocked' as const,
        createdAt: at(5),
      },
      { ...asked, buyerId: other.id, approveUrl: APPROVE_URL, createdAt: at(6) },
    ])
    .returning({ id: purchases.id });
  [ids.asked, ids.badLink, ids.noLink, ids.unknownSeller, ids.otherBuyer] = inserted.map((row) => row.id);
});

describe('pendingApprovals', () => {
  it("lists the buyer's purchases waiting for approval, newest first, with what each one buys and why", async () => {
    const waiting = {
      seller: SEEDED_SELLER.name,
      totalCents: 3200,
      items: [{ sku: 'SAF-1', title: 'Saffron, 1 g', quantity: 2, unitPriceCents: 1600 }],
      reasons: ['Over $25.00, so you approve it.', 'You asked for one gram; the cart has two.'],
    };
    expect(await pendingApprovals(db, buyerId)).toEqual([
      { ...waiting, id: ids.noLink, createdAt: at(4), approveUrl: null },
      { ...waiting, id: ids.badLink, createdAt: at(3), approveUrl: null },
      { ...waiting, id: ids.asked, createdAt: at(2), approveUrl: APPROVE_URL },
    ]);
  });

  it('gives the reasons the purchase flow reports', async () => {
    const [latest] = await pendingApprovals(db, buyerId);
    expect(latest.reasons).toEqual((await purchaseOutcome(db, latest.id)).reasons);
  });

  it('lists nothing for a buyer with nothing waiting', async () => {
    const [nobody] = await db.insert(buyers).values({ name: 'Meera' }).returning();
    expect(await pendingApprovals(db, nobody.id)).toEqual([]);
  });
});
