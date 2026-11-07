import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { purchaseDetails } from '@/lib/buyer-pages/detail';
import { mandateInForce } from '@/lib/buyer-pages/mandate';
import { changeFor, gateReplay } from '@/lib/buyer-pages/what-would-change';
import type { Db } from '@/lib/db/client';
import { buyers, mandates, products, purchases, receipts, wallets } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { evaluateGate } from '@/lib/gate/evaluate';
import { purchaseRow, SEEDED_SELLER, seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The buyer's purchases in full, and what would have let each one through, read back from the
// database as the ledger, the approvals page and the shop show them.

const at = (minute: number) => new Date(Date.UTC(2026, 10, 7, 9, minute));
const NOW = at(30);
const RECEIPT_ID = '0b6a3f5e-1d2c-4e8f-9a7b-3c5d6e7f8a90';

const giftCart: Cart = {
  seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
  currency: 'USD',
  items: [{ sku: 'GIFT-SET', title: 'Spice gift box', category: 'spices', unitPriceCents: 4000, quantity: 1 }],
  totalCents: 4000,
};

let db: Db;
let buyerId: string;
let mandateId: string;
const ids = { paid: '', held: '', flagged: '', otherBuyer: '' };

/**
 * Priya, under the demo mandate ($60.00 a month, ask above $25.00), with a linked wallet: $18.75 of
 * spices paid with a receipt, then a $40.00 gift box waiting for her approval, then saffron the
 * gate blocked because its listing speaks to AI agents. Another buyer has a purchase too.
 */
beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedPurchase(db, 'captured');
  ({ buyerId, mandateId } = seeded);
  ids.paid = seeded.purchaseId;
  await db.update(purchases).set({ createdAt: at(1), paypalOrderId: 'ORDER-1', paypalCaptureId: 'CAPTURE-1', capturedAt: at(2) }).where(eq(purchases.id, ids.paid));
  await db.insert(receipts).values({ id: RECEIPT_ID, purchaseId: ids.paid, jws: 'not.a.jws', payloadHash: 'b'.repeat(64), keyId: 'stored-kid' });
  await db.insert(wallets).values({ buyerId, status: 'linked', paymentTokenId: 'TOKEN-1' });
  await db.insert(products).values(
    [
      { sku: 'TUR-100', title: 'Turmeric, 100 g', priceCents: 450, flags: [] as string[] },
      { sku: 'CUM-100', title: 'Cumin, 100 g', priceCents: 975, flags: [] as string[] },
      { sku: 'GIFT-SET', title: 'Spice gift box', priceCents: 4000, flags: [] as string[] },
      { sku: 'SAF-1G', title: 'Kashmiri saffron 1g', priceCents: 1200, flags: ['agent_instructions'] },
    ].map((p) => ({ ...p, sellerId: seeded.sellerId, description: p.title, category: 'spices' as const, stock: 10 })),
  );

  const base = await purchaseRow(db, ids.paid);
  const copy = { ...base, id: undefined, updatedAt: undefined, approver: null, paypalOrderId: null, paypalCaptureId: null, capturedAt: null };
  const [{ policy }] = await db.select({ policy: mandates.policy }).from(mandates).where(eq(mandates.id, mandateId));
  const held = evaluateGate({
    policy,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
    proposal: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'GIFT-SET', quantity: 1 }], rationale: 'A gift' },
    catalog: new Map([['GIFT-SET', { sku: 'GIFT-SET', title: 'Spice gift box', category: 'spices', priceCents: 4000, stock: 10, flags: [], marketMedianCents: null }]]),
    spentInPeriodCents: 1875,
    recentPurchaseTimes: [],
    now: at(10),
  });
  const [heldRow] = await db
    .insert(purchases)
    .values({
      ...copy,
      proposal: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'GIFT-SET', quantity: 1 }], rationale: 'A gift' },
      cart: giftCart,
      totalCents: 4000,
      gateVerdict: 'ASK',
      gateOutcomes: held.outcomes,
      intent: { verdict: 'consistent', reasons: [] },
      finalVerdict: 'ASK',
      status: 'awaiting_approval',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T',
      createdAt: at(10),
    })
    .returning();
  ids.held = heldRow.id;

  const [flaggedRow] = await db
    .insert(purchases)
    .values({
      ...copy,
      proposal: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'SAF-1G', quantity: 1 }], rationale: 'Saffron' },
      cart: null,
      totalCents: null,
      gateVerdict: 'BLOCK',
      gateOutcomes: [{ rule: 'listing_clean', result: 'block', detail: 'Kashmiri saffron 1g contains instructions aimed at AI agents' }],
      intent: null,
      finalVerdict: 'BLOCK',
      status: 'blocked',
      createdAt: at(20),
    })
    .returning();
  ids.flagged = flaggedRow.id;

  const [other] = await db.insert(buyers).values({ name: 'Someone else' }).returning();
  const [otherRow] = await db.insert(purchases).values({ ...copy, buyerId: other.id, createdAt: at(25) }).returning();
  ids.otherBuyer = otherRow.id;
});

describe('purchaseDetails', () => {
  it("lists only the buyer's purchases, newest first", async () => {
    const details = await purchaseDetails(db, { buyerId }, NOW);
    expect(details.map((d) => d.id)).toEqual([ids.flagged, ids.held, ids.paid]);
  });

  it('gives a paid purchase its full trace, its PayPal ids and its receipt, and nothing to change', async () => {
    const [paid] = await purchaseDetails(db, { buyerId, purchaseId: ids.paid }, NOW);
    expect(paid.trace).toEqual({ mandate: 'done', gate: 'done', intent: 'done', paypal: 'done', receipt: 'done' });
    expect(paid.paypal).toEqual({ orderId: 'ORDER-1', captureId: 'CAPTURE-1', capturedAt: at(2).toISOString() });
    expect(paid.receipt).toEqual({ id: RECEIPT_ID, keyId: 'stored-kid', jws: 'not.a.jws', decisionHash: null });
    expect(paid.mandate).toMatchObject({ id: mandateId, confirmation: 'session', credentialId: null });
    expect(paid.change).toBeNull();
  });

  it('names the passkey that signed the mandate and the decision record the receipt commits to', async () => {
    const token = (payload: object) =>
      [{ alg: 'EdDSA' }, payload].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.') + '.c2ln';
    const passkey = { credentialId: 'cred-AbC_123', publicKey: 'pQECAyYgASFYIA', alg: -7 };
    const [{ jws: mandateJws }] = await db.select({ jws: mandates.jws }).from(mandates).where(eq(mandates.id, mandateId));
    await db.update(mandates).set({ confirmation: 'passkey', jws: token({ confirmation: 'passkey', passkey }) }).where(eq(mandates.id, mandateId));
    await db.update(receipts).set({ jws: token({ v: 1, agent: { decisionHash: 'd'.repeat(64) } }) }).where(eq(receipts.id, RECEIPT_ID));
    try {
      const [paid] = await purchaseDetails(db, { buyerId, purchaseId: ids.paid }, NOW);
      expect(paid.mandate).toMatchObject({ confirmation: 'passkey', credentialId: 'cred-AbC_123' });
      expect(paid.receipt?.decisionHash).toBe('d'.repeat(64));
    } finally {
      await db.update(mandates).set({ confirmation: 'session', jws: mandateJws }).where(eq(mandates.id, mandateId));
      await db.update(receipts).set({ jws: 'not.a.jws' }).where(eq(receipts.id, RECEIPT_ID));
    }
  });

  it('gives a held purchase its approval link and the changes that would have allowed it', async () => {
    const [held] = await purchaseDetails(db, { buyerId, status: 'awaiting_approval' }, NOW);
    expect(held.id).toBe(ids.held);
    expect(held.trace).toEqual({ mandate: 'done', gate: 'held', intent: 'done', paypal: 'held', receipt: 'not_reached' });
    expect(held.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(held.change).toEqual({
      kind: 'changes',
      approve: true,
      together: false,
      changes: [
        { text: 'Raise your approval limit to $40.00', outcome: 'ALLOW' },
        { text: 'Stop asking you about purchases on their amount alone', outcome: 'ALLOW' },
      ],
    });
  });

  it('says a purchase blocked for a flagged listing cannot be allowed', async () => {
    const [flagged] = await purchaseDetails(db, { buyerId, purchaseId: ids.flagged }, NOW);
    expect(flagged.trace.gate).toBe('stopped');
    expect(flagged.change).toEqual({ kind: 'cannot', reason: 'Kashmiri saffron 1g contains instructions aimed at AI agents.' });
  });
});

describe('gateReplay', () => {
  it("counts the spend before the purchase, not the purchase's own", async () => {
    const replay = await gateReplay(db, ids.held, NOW);
    expect(replay?.input.spentInPeriodCents).toBe(1875);
    expect(replay?.input.now).toEqual(at(10));
    expect(replay?.input.walletLinked).toBe(true);
    expect(evaluateGate(replay!.input).verdict).toBe('ASK');
  });
});

describe('mandateInForce', () => {
  it('counts every purchase that holds budget this period', async () => {
    expect(await mandateInForce(db, buyerId, NOW)).toMatchObject({
      id: mandateId,
      readback: ['Up to $60.00 a month.'],
      budgetCents: 6000,
      period: 'month',
      spentCents: 5875,
      leftCents: 125,
      perPurchaseMaxCents: 6000,
      askAboveCents: 2500,
      expiresAt: null,
    });
  });
});

describe('after the mandate is revoked', () => {
  beforeAll(async () => {
    await db.update(mandates).set({ status: 'revoked' }).where(eq(mandates.id, mandateId));
  });

  it('suggests no change to it', async () => {
    expect(await changeFor(db, ids.held, NOW)).toEqual({ kind: 'cannot', reason: 'This mandate was revoked.' });
  });

  it('has no mandate in force', async () => {
    expect(await mandateInForce(db, buyerId, NOW)).toBeNull();
  });
});
