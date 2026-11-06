import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { buyers, mandates, payouts, products, purchaseEvents, purchases, receipts, sellers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME, DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { loadDashboardData, type DashboardDeps } from '@/lib/dashboard/scope';
import type { Cart } from '@/lib/domain/cart';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { Transaction } from '@/lib/paypal';
import { createTestDb } from '@/tests/helpers/test-db';

const HASH = 'a'.repeat(64);
const NOW = new Date('2026-11-06T12:00:00Z');
const DAY_MS = 86_400_000;

const policy: MandatePolicy = {
  version: 1,
  currency: 'USD',
  budget: { amountCents: 6000, period: 'week' },
  perPurchaseMaxCents: 6000,
  askAboveCents: 2500,
  categories: { allow: null, deny: [] },
  merchants: { allow: null, deny: [] },
  velocity: null,
  expiresAt: null,
};

function cartAt(slug: string, totalCents: number): Cart {
  return {
    seller: { slug, name: slug },
    currency: 'USD',
    items: [{ sku: 'SKU-1', title: 'Item', category: 'spices', unitPriceCents: totalCents, quantity: 1 }],
    totalCents,
  };
}

/**
 * Two buyers (the demo buyer and another), two sellers (the demo seller and another) and one
 * purchase for each buyer at each seller, each with an event, a receipt and a payout.
 */
async function seed(db: Db) {
  const [priya, arjun] = await db
    .insert(buyers)
    .values([{ name: DEMO_BUYER_NAME }, { name: 'Arjun' }])
    .returning();
  const [ravi, gadgets] = await db
    .insert(sellers)
    .values([
      { slug: DEMO_SELLER_SLUG, name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
      { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
    ])
    .returning();
  await db.insert(products).values([
    { sellerId: ravi.id, sku: 'TUR-100', title: 'Turmeric', category: 'spices', priceCents: 450 },
    { sellerId: gadgets.id, sku: 'EAR-01', title: 'Wireless earbuds', category: 'electronics', priceCents: 2900 },
  ]);

  const mandateFor = (buyerId: string) => ({
    buyerId,
    sourceText: '$60 a week',
    policy,
    policyHash: HASH,
    readback: ['Up to $60.00 a week.'],
    readbackHash: HASH,
    jws: 'mandate.jws.value',
    confirmedAt: new Date('2026-11-02T09:00:00Z'),
  });
  const [priyaMandate, arjunMandate] = await db
    .insert(mandates)
    .values([mandateFor(priya.id), mandateFor(arjun.id)])
    .returning();

  const parties = [
    { label: 'priya-ravi', buyerId: priya.id, mandateId: priyaMandate.id, seller: ravi, minutesAgo: 40 },
    { label: 'priya-gadgets', buyerId: priya.id, mandateId: priyaMandate.id, seller: gadgets, minutesAgo: 30 },
    { label: 'arjun-ravi', buyerId: arjun.id, mandateId: arjunMandate.id, seller: ravi, minutesAgo: 20 },
    { label: 'arjun-gadgets', buyerId: arjun.id, mandateId: arjunMandate.id, seller: gadgets, minutesAgo: 10 },
  ];
  const ids: Record<string, string> = {};
  for (const [index, p] of parties.entries()) {
    const totalCents = 1000 + index;
    const [row] = await db
      .insert(purchases)
      .values({
        buyerId: p.buyerId,
        mandateId: p.mandateId,
        sellerId: p.seller.id,
        request: `request ${p.label}`,
        proposal: { sellerSlug: p.seller.slug, items: [{ sku: 'SKU-1', quantity: 1 }], rationale: 'r' },
        cart: cartAt(p.seller.slug, totalCents),
        cartHash: HASH,
        totalCents,
        gateVerdict: 'ALLOW',
        gateOutcomes: [{ rule: 'mandate_active', result: 'pass', detail: 'The mandate is active.' }],
        rulesetVersion: 'gate-v1',
        finalVerdict: 'ALLOW',
        approver: 'policy',
        status: 'settled',
        paypalOrderId: `ORDER-${p.label}`,
        paypalCaptureId: `CAPTURE-${p.label}`,
        approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=secret',
        createdAt: new Date(NOW.getTime() - p.minutesAgo * 60_000),
      })
      .returning();
    ids[p.label] = row.id;
    await db.insert(purchaseEvents).values({ purchaseId: row.id, kind: 'settled', data: { note: p.label } });
    await db.insert(receipts).values({ purchaseId: row.id, jws: `receipt.${p.label}.sig`, payloadHash: HASH, keyId: 'k1' });
    await db.insert(payouts).values({
      purchaseId: row.id,
      sellerId: p.seller.id,
      amountCents: totalCents,
      senderBatchId: `${row.id}:payout`,
      status: 'SUCCESS',
    });
  }
  return { ids, priyaMandateId: priyaMandate.id, ravi, gadgets };
}

const purchaseIdsOf = (rows: { purchaseId: string }[]) => rows.map((r) => r.purchaseId).sort();

function noTransactions(): DashboardDeps & { loadTransactions: ReturnType<typeof vi.fn> } {
  return { now: NOW, loadTransactions: vi.fn(async () => []) };
}

let db: Db;
let seeded: Awaited<ReturnType<typeof seed>>;

beforeEach(async () => {
  db = await createTestDb();
  seeded = await seed(db);
});

describe('loadDashboardData for the buyer', () => {
  it('shows only the demo buyer purchases and what hangs off them', async () => {
    const deps = noTransactions();
    const data = await loadDashboardData(db, 'buyer', deps);
    const { ids } = seeded;
    const own = [ids['priya-ravi'], ids['priya-gadgets']].sort();

    expect(data.persona).toBe('buyer');
    expect(data.purchases.map((p) => p.id).sort()).toEqual(own);
    expect(purchaseIdsOf(data.purchaseEvents)).toEqual(own);
    expect(purchaseIdsOf(data.receipts)).toEqual(own);
    expect(purchaseIdsOf(data.payouts)).toEqual(own);
    expect(data.mandates.map((m) => m.id)).toEqual([seeded.priyaMandateId]);
  });

  it('sees every seller catalogue, which is public', async () => {
    const data = await loadDashboardData(db, 'buyer', noTransactions());
    expect(data.sellers.map((s) => s.slug).sort()).toEqual(['gadget-hub', DEMO_SELLER_SLUG]);
    expect(data.products.map((p) => p.sku).sort()).toEqual(['EAR-01', 'TUR-100']);
  });

  it('never loads PayPal transactions', async () => {
    const deps = noTransactions();
    const data = await loadDashboardData(db, 'buyer', deps);
    expect(data.transactions).toEqual([]);
    expect(deps.loadTransactions).not.toHaveBeenCalled();
  });

  it('sees no purchases or mandates when the demo buyer does not exist yet', async () => {
    const empty = await createTestDb();
    await empty.insert(buyers).values({ name: 'Arjun' });
    const data = await loadDashboardData(empty, 'buyer', noTransactions());
    expect(data.purchases).toEqual([]);
    expect(data.mandates).toEqual([]);
  });
});

describe('loadDashboardData for the seller', () => {
  it('shows only purchases, receipts and payouts at the demo seller', async () => {
    const data = await loadDashboardData(db, 'seller', noTransactions());
    const { ids } = seeded;
    const own = [ids['priya-ravi'], ids['arjun-ravi']].sort();

    expect(data.purchases.map((p) => p.id).sort()).toEqual(own);
    expect(data.purchases.every((p) => p.sellerId === seeded.ravi.id)).toBe(true);
    expect(purchaseIdsOf(data.purchaseEvents)).toEqual(own);
    expect(purchaseIdsOf(data.receipts)).toEqual(own);
    expect(purchaseIdsOf(data.payouts)).toEqual(own);
  });

  it('sees only its own seller record and catalogue, and no mandates', async () => {
    const deps = noTransactions();
    const data = await loadDashboardData(db, 'seller', deps);
    expect(data.sellers.map((s) => s.slug)).toEqual([DEMO_SELLER_SLUG]);
    expect(data.products.map((p) => p.sku)).toEqual(['TUR-100']);
    expect(data.mandates).toEqual([]);
    expect(data.transactions).toEqual([]);
    expect(deps.loadTransactions).not.toHaveBeenCalled();
  });

  it('sees nothing when the demo seller does not exist yet', async () => {
    const empty = await createTestDb();
    const data = await loadDashboardData(empty, 'seller', noTransactions());
    expect(data.purchases).toEqual([]);
    expect(data.sellers).toEqual([]);
    expect(data.products).toEqual([]);
  });
});

describe('loadDashboardData for the operator', () => {
  it('shows every purchase, newest first, with everything that hangs off them', async () => {
    const data = await loadDashboardData(db, 'operator', noTransactions());
    const { ids } = seeded;

    expect(data.purchases.map((p) => p.id)).toEqual([
      ids['arjun-gadgets'],
      ids['arjun-ravi'],
      ids['priya-gadgets'],
      ids['priya-ravi'],
    ]);
    expect(data.purchaseEvents).toHaveLength(4);
    expect(data.receipts).toHaveLength(4);
    expect(data.payouts).toHaveLength(4);
    expect(data.mandates).toHaveLength(2);
    expect(data.sellers).toHaveLength(2);
    expect(data.products).toHaveLength(2);
  });

  it('adds the last 31 days of PayPal transactions, matched to purchases by capture id', async () => {
    const capture: Transaction = {
      transaction_info: {
        transaction_id: 'CAPTURE-priya-ravi',
        transaction_event_code: 'T0006',
        transaction_initiation_date: '2026-11-06T11:20:00+0000',
        transaction_amount: { value: '10.00', currency_code: 'USD' },
        fee_amount: { value: '-0.79', currency_code: 'USD' },
        transaction_status: 'S',
      },
    };
    const loadTransactions = vi.fn(async () => [capture]);
    const data = await loadDashboardData(db, 'operator', { now: NOW, loadTransactions });

    expect(loadTransactions).toHaveBeenCalledWith(new Date(NOW.getTime() - 31 * DAY_MS), NOW);
    expect(data.transactions).toHaveLength(1);
    expect(data.transactions[0]).toMatchObject({
      id: 'CAPTURE-priya-ravi',
      purchaseId: seeded.ids['priya-ravi'],
      amountCents: 1000,
      feeCents: -79,
    });
    expect(data.warnings).toEqual([]);
  });

  it('still returns everything else, with a warning, when Transaction Search fails', async () => {
    const loadTransactions = vi.fn(async () => {
      throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
    });
    const data = await loadDashboardData(db, 'operator', { now: NOW, loadTransactions });

    expect(data.transactions).toEqual([]);
    expect(data.warnings).toEqual([
      'PayPal transactions could not be loaded: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set',
    ]);
    expect(data.purchases).toHaveLength(4);
  });
});

describe('dashboard rows', () => {
  it('are plain JSON with ISO timestamps', async () => {
    const data = await loadDashboardData(db, 'operator', noTransactions());
    expect(data.asOf).toBe(NOW.toISOString());
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect(data.purchases[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('leave out payout emails, approval links and event payloads', async () => {
    const data = await loadDashboardData(db, 'operator', noTransactions());
    expect(data.sellers[0]).not.toHaveProperty('payoutEmail');
    expect(data.purchases[0]).not.toHaveProperty('approveUrl');
    expect(data.purchaseEvents[0]).not.toHaveProperty('data');
  });

  it('carry what the dashboard draws from: verdicts, rule outcomes, cart and receipt', async () => {
    const data = await loadDashboardData(db, 'operator', noTransactions());
    const purchase = data.purchases.find((p) => p.id === seeded.ids['priya-ravi']);
    expect(purchase).toMatchObject({
      gateVerdict: 'ALLOW',
      finalVerdict: 'ALLOW',
      status: 'settled',
      totalCents: 1000,
      gateOutcomes: [{ rule: 'mandate_active', result: 'pass', detail: 'The mandate is active.' }],
      cart: cartAt(DEMO_SELLER_SLUG, 1000),
    });
    expect(data.receipts.find((r) => r.purchaseId === purchase?.id)).toMatchObject({
      jws: 'receipt.priya-ravi.sig',
      keyId: 'k1',
    });
    expect(data.mandates[0].policy.budget).toEqual({ amountCents: 6000, period: 'week' });
  });
});
