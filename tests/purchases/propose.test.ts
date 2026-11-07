import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buyers, mandates, products, purchases, receipts, sellers, wallets, type PurchaseStatus, type WalletStatus } from '@/lib/db/schema';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { evaluateGate, type CatalogEntry } from '@/lib/gate/evaluate';
import { GATE_RULES } from '@/lib/gate/rules';
import type { IntentInput, IntentResult } from '@/lib/intent/types';
import { confirmMandate } from '@/lib/mandate/confirm';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { proposePurchase } from '@/lib/purchases/propose';
import { hashOf } from '@/lib/receipts/canonical';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { FakeSeller, NOW, signer } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, SEEDED_SELLER } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
/** The demo mandate's budget is monthly, so its period began at the start of the month, UTC. */
const MONTH_START = new Date('2026-11-01T00:00:00.000Z');
const EARLIER_THIS_MONTH = new Date('2026-11-03T10:00:00Z');

const MANDATE_TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';
const READBACK = ['Up to $60.00 a month.', 'Ask me before any purchase over $25.00.', 'Never electronics.'];
const REQUEST = 'Restock turmeric and garam masala';
const RATIONALE = 'The buyer asked me to restock their spices.';
const RUN_ID = 'run-1';

const listing = (entry: Omit<CatalogEntry, 'flags' | 'marketMedianCents'> & Partial<CatalogEntry>): CatalogEntry => ({
  flags: [],
  marketMedianCents: null,
  ...entry,
});

/** What the demo seller lists. Turmeric has a market benchmark; the others do not. */
const LISTINGS: CatalogEntry[] = [
  listing({ sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', priceCents: 450, stock: 40, marketMedianCents: 400 }),
  listing({ sku: 'GAR-200', title: 'Garam masala 200g', category: 'spices', priceCents: 600, stock: 25 }),
  listing({ sku: 'EAR-01', title: 'Wireless earbuds', category: 'electronics', priceCents: 1999, stock: null }),
];

/** Another seller listing one of the same SKUs far cheaper, which must never price the demo seller's cart. */
const OTHER_SELLER = { slug: 'cheap-spices', name: 'Cheap Spices', payoutEmail: 'payouts@cheap-spices.example.com' };

/**
 * The intent check, answering as the test says and recording what it was asked. A test can run
 * something while the check is deciding, as the buyer or the clock might act during a real call.
 */
class FakeIntent {
  readonly inputs: IntentInput[] = [];
  answer: IntentResult | Error = { verdict: 'consistent', reasons: [] };
  whileChecking: () => Promise<void> = async () => {};

  async check(input: IntentInput): Promise<IntentResult> {
    this.inputs.push(input);
    await this.whileChecking();
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

/**
 * The demo buyer with an active mandate under `policy` and a saved wallet in `wallet` status, the
 * demo seller's catalog, another seller's, a fake PayPal, a fake seller, a fake intent check and a
 * clock the test can move. No purchase exists yet.
 */
async function setUp({
  policy = demoPolicy,
  wallet = 'linked',
  logQuery,
}: { policy?: MandatePolicy; wallet?: WalletStatus; logQuery?: (query: string) => void } = {}) {
  const db = await createTestDb(logQuery ? { logger: { logQuery } } : {});
  const [buyer] = await db.insert(buyers).values({ name: 'Priya' }).returning();
  const [seller] = await db.insert(sellers).values(SEEDED_SELLER).returning();
  const [other] = await db.insert(sellers).values(OTHER_SELLER).returning();
  await db.insert(products).values(LISTINGS.map((entry) => ({ sellerId: seller.id, ...entry })));
  await db
    .insert(products)
    .values({ sellerId: other.id, sku: 'GAR-200', title: 'Garam masala 200g', category: 'spices', priceCents: 100 });
  const [mandate] = await db
    .insert(mandates)
    .values({
      buyerId: buyer.id,
      sourceText: MANDATE_TEXT,
      policy,
      policyHash: hashOf(policy),
      readback: READBACK,
      readbackHash: hashOf(READBACK),
      jws: 'mandate.jws.value',
      confirmedAt: new Date('2026-11-01T09:00:00Z'),
    })
    .returning();
  await db.insert(wallets).values({
    buyerId: buyer.id,
    status: wallet,
    paypalCustomerId: 'CUSTOMER-1',
    paymentTokenId: 'TOKEN-1',
    linkedAt: NOW,
  });
  const paypal = new FakePaypal();
  const intent = new FakeIntent();
  const clock = { now: NOW };
  const now = () => clock.now;
  const deps: PurchaseDeps = {
    db,
    paypal,
    signer,
    intent: (input) => intent.check(input),
    sellers: new FakeSeller(now),
    appUrl: 'https://behest.example.com',
    now,
  };
  return { db, deps, paypal, intent, clock, buyerId: buyer.id, sellerId: seller.id, mandateId: mandate.id };
}

type SetUp = Awaited<ReturnType<typeof setUp>>;

const proposal = (...items: [sku: string, quantity: number][]): PurchaseProposal => ({
  sellerSlug: SEEDED_SELLER.slug,
  items: items.map(([sku, quantity]) => ({ sku, quantity })),
  rationale: RATIONALE,
});

function propose(s: SetUp, p: PurchaseProposal) {
  return proposePurchase(s.deps, { buyerId: s.buyerId, runId: RUN_ID, request: REQUEST, proposal: p });
}

/** An earlier purchase of the buyer, made at `createdAt`, now in `status`. */
async function addEarlierPurchase(s: SetUp, status: PurchaseStatus, totalCents: number, createdAt: Date) {
  await s.db.insert(purchases).values({
    buyerId: s.buyerId,
    mandateId: s.mandateId,
    sellerId: s.sellerId,
    request: 'An earlier request',
    proposal: proposal(['TUR-100', 1]),
    totalCents,
    gateVerdict: 'ALLOW',
    rulesetVersion: 'gate-v1',
    status,
    createdAt,
  });
}

/** What the gate said about the budget when it decided the purchase. */
async function budgetDetail(s: SetUp, purchaseId: string) {
  return (await purchaseRow(s.db, purchaseId)).gateOutcomes.find((o) => o.rule === 'budget_remaining')?.detail;
}

/** The kinds of the purchase's events other than status changes, in order. */
async function stepsOf(s: SetUp, purchaseId: string): Promise<string[]> {
  return (await eventsOf(s.db, purchaseId)).filter((e) => e.kind !== 'status').map((e) => e.kind);
}

/** The `gate` event's data: the verdict, the rule set and each rule's result, with no free text. */
const gateEvent = (verdict: string, results: Partial<Record<(typeof GATE_RULES)[number], string>> = {}) => ({
  kind: 'gate',
  data: { verdict, rulesetVersion: 'gate-v1', outcomes: GATE_RULES.map((rule) => ({ rule, result: results[rule] ?? 'pass' })) },
});

it('blocks electronics without calling intent or PayPal', async () => {
  const s = await setUp();

  const outcome = await propose(s, proposal(['EAR-01', 1]));

  expect(outcome).toEqual({
    purchaseId: expect.any(String),
    verdict: 'BLOCK',
    status: 'blocked',
    reasons: ['electronics is not allowed by your mandate'],
    approveUrl: null,
    receiptId: null,
  });
  expect(s.intent.inputs).toEqual([]);
  expect(s.paypal.calls).toEqual([]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({
    status: 'blocked',
    gateVerdict: 'BLOCK',
    finalVerdict: 'BLOCK',
    intent: null,
  });
  // Inserted already blocked, so no status change is logged.
  expect(await eventsOf(s.db, outcome.purchaseId)).toEqual([
    gateEvent('BLOCK', { category_allowed: 'block', price_benchmark: 'skip' }),
  ]);
});

it('records all gate outcomes on the purchase', async () => {
  const s = await setUp();
  const p = proposal(['TUR-100', 6], ['GAR-200', 1]);

  const outcome = await propose(s, p);

  const cart = {
    seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
    currency: 'USD',
    items: [
      { sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', unitPriceCents: 450, quantity: 6 },
      { sku: 'GAR-200', title: 'Garam masala 200g', category: 'spices', unitPriceCents: 600, quantity: 1 },
    ],
    totalCents: 3300,
  };
  // What the gate decides given everything the purchase flow should have loaded for it.
  const expected = evaluateGate({
    policy: demoPolicy,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
    proposal: p,
    catalog: new Map(LISTINGS.map((entry) => [entry.sku, entry])),
    spentInPeriodCents: 0,
    recentPurchaseTimes: [],
    now: NOW,
  });
  const row = await purchaseRow(s.db, outcome.purchaseId);
  expect(row).toMatchObject({
    buyerId: s.buyerId,
    mandateId: s.mandateId,
    sellerId: s.sellerId,
    runId: RUN_ID,
    request: REQUEST,
    proposal: p,
    cart,
    cartHash: hashOf(cart),
    totalCents: 3300,
    gateVerdict: 'ASK',
    gateOutcomes: expected.outcomes,
    gateReasons: ['$33.00 is over your $25.00 approval limit', 'Turmeric powder 100g has a quantity of 6, more than 5'],
    rulesetVersion: 'gate-v1',
    createdAt: NOW,
  });
  expect(row.gateOutcomes.map(({ rule, result }) => [rule, result])).toEqual(
    GATE_RULES.map((rule) => [rule, rule === 'ask_threshold' || rule === 'quantity' ? 'ask' : 'pass']),
  );
  expect((await eventsOf(s.db, outcome.purchaseId))[0]).toEqual(gateEvent('ASK', { ask_threshold: 'ask', quantity: 'ask' }));
});

it("gives the intent check the buyer's own request, the mandate and the agent's rationale", async () => {
  const s = await setUp();

  await propose(s, proposal(['TUR-100', 2]));

  expect(s.intent.inputs).toEqual([
    {
      mandateText: MANDATE_TEXT,
      readback: READBACK,
      request: REQUEST,
      cart: {
        seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
        currency: 'USD',
        items: [{ sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', unitPriceCents: 450, quantity: 2 }],
        totalCents: 900,
      },
      agentRationale: RATIONALE,
    },
  ]);
});

it('charges an allowed purchase, logging the gate, intent, charge, capture, receipt and seller acceptance in order', async () => {
  const s = await setUp();

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  const [receipt] = await s.db.select().from(receipts);
  expect(outcome).toEqual({
    purchaseId: expect.any(String),
    verdict: 'ALLOW',
    status: 'accepted',
    reasons: [],
    approveUrl: null,
    receiptId: receipt.id,
  });
  const { purchaseId } = outcome;
  expect(s.paypal.callsTo('chargeSavedWallet')).toEqual([[expect.objectContaining({ amountCents: 900, requestId: `${purchaseId}:charge` })]]);
  expect(await purchaseRow(s.db, purchaseId)).toMatchObject({
    gateVerdict: 'ALLOW',
    intent: { verdict: 'consistent', reasons: [] },
    finalVerdict: 'ALLOW',
    approver: 'policy',
  });
  expect(await stepsOf(s, purchaseId)).toEqual(['gate', 'intent', 'charge', 'capture', 'receipt', 'seller_accepted']);
  const events = await eventsOf(s.db, purchaseId);
  expect(events.map((e) => e.kind)).toEqual(['gate', 'intent', 'status', 'charge', 'capture', 'status', 'receipt', 'seller_accepted', 'status']);
  expect(events.slice(0, 3)).toEqual([
    gateEvent('ALLOW'),
    { kind: 'intent', data: { verdict: 'consistent', finalVerdict: 'ALLOW' } },
    { kind: 'status', data: { from: 'proposed', to: 'charging' } },
  ]);
});

it('downgrades ALLOW to ASK when intent is unavailable', async () => {
  const s = await setUp();
  s.intent.answer = { verdict: 'unavailable', reasons: ['api_error'] };

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toEqual({
    purchaseId: expect.any(String),
    verdict: 'ASK',
    status: 'awaiting_approval',
    reasons: ['api_error'],
    approveUrl: expect.stringMatching(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/),
    receiptId: null,
  });
  expect(s.paypal.callsTo('chargeSavedWallet')).toEqual([]);
  expect(s.paypal.callsTo('createApprovalOrder')).toEqual([
    [expect.objectContaining({ amountCents: 900, requestId: `${outcome.purchaseId}:approval` })],
  ]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({
    gateVerdict: 'ALLOW',
    intent: { verdict: 'unavailable', reasons: ['api_error'] },
    finalVerdict: 'ASK',
  });
  expect(await stepsOf(s, outcome.purchaseId)).toEqual(['gate', 'intent', 'approval_order']);
});

it('sends the purchase to its buyer, never charging, when the intent check throws', async () => {
  const s = await setUp();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('socket hang up');
  s.intent.answer = failure;

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toMatchObject({ verdict: 'ASK', status: 'awaiting_approval', reasons: ['internal_error'] });
  expect(s.paypal.callsTo('chargeSavedWallet')).toEqual([]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({
    gateVerdict: 'ALLOW',
    intent: { verdict: 'unavailable', reasons: ['internal_error'] },
    finalVerdict: 'ASK',
  });
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('intent check failed'), failure);
});

it.each([
  ['nothing', null],
  ['reasons that are not a list', { verdict: 'consistent', reasons: 'Looks fine' }],
])('sends the purchase to its buyer, never charging, when the intent check answers with %s', async (_, answer) => {
  const s = await setUp();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  s.intent.answer = answer as unknown as IntentResult;

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toMatchObject({ verdict: 'ASK', status: 'awaiting_approval', reasons: ['internal_error'] });
  expect(s.paypal.callsTo('chargeSavedWallet')).toEqual([]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({
    gateVerdict: 'ALLOW',
    intent: { verdict: 'unavailable', reasons: ['internal_error'] },
    finalVerdict: 'ASK',
  });
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('intent check failed'), expect.anything());
});

it('blocks when intent says inconsistent', async () => {
  const s = await setUp();
  const concern = 'The buyer asked for turmeric and garam masala, not this.';
  s.intent.answer = { verdict: 'inconsistent', reasons: [concern] };

  const outcome = await propose(s, proposal(['GAR-200', 1]));

  expect(outcome).toEqual({
    purchaseId: expect.any(String),
    verdict: 'BLOCK',
    status: 'blocked',
    reasons: [concern],
    approveUrl: null,
    receiptId: null,
  });
  expect(s.paypal.calls).toEqual([]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({ gateVerdict: 'ALLOW', finalVerdict: 'BLOCK' });
  expect(await eventsOf(s.db, outcome.purchaseId)).toEqual([
    gateEvent('ALLOW', { price_benchmark: 'skip' }),
    { kind: 'intent', data: { verdict: 'inconsistent', finalVerdict: 'BLOCK' } },
    { kind: 'status', data: { from: 'proposed', to: 'blocked' } },
  ]);
});

it('blocks the purchase, with no PayPal call, when its buyer confirms a new mandate during the intent check', async () => {
  const s = await setUp();
  // Confirming a new mandate revokes the one the gate checked the purchase against.
  s.intent.whileChecking = async () => {
    await confirmMandate({ db: s.db, signer, now: () => NOW }, { buyerId: s.buyerId, text: MANDATE_TEXT, policy: demoPolicy });
  };

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toEqual({
    purchaseId: expect.any(String),
    verdict: 'BLOCK',
    status: 'blocked',
    reasons: ['This mandate was revoked'],
    approveUrl: null,
    receiptId: null,
  });
  expect(s.paypal.calls).toEqual([]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({
    mandateId: s.mandateId,
    gateVerdict: 'ALLOW',
    intent: { verdict: 'consistent', reasons: [] },
    finalVerdict: 'BLOCK',
  });
  expect(await eventsOf(s.db, outcome.purchaseId)).toEqual([
    gateEvent('ALLOW'),
    { kind: 'intent', data: { verdict: 'consistent', finalVerdict: 'ALLOW' } },
    { kind: 'mandate_changed', data: { mandateId: s.mandateId, reason: 'This mandate was revoked', finalVerdict: 'BLOCK' } },
    { kind: 'status', data: { from: 'proposed', to: 'blocked' } },
  ]);
});

it('blocks the purchase, with no PayPal call, when its mandate expires during the intent check', async () => {
  const s = await setUp();
  await s.db
    .update(mandates)
    .set({ expiresAt: new Date(NOW.getTime() + 60_000) })
    .where(eq(mandates.id, s.mandateId));
  s.intent.whileChecking = async () => {
    s.clock.now = new Date(NOW.getTime() + 60_000);
  };

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toMatchObject({ verdict: 'BLOCK', status: 'blocked', reasons: ['This mandate has expired'] });
  expect(s.paypal.calls).toEqual([]);
  expect(await stepsOf(s, outcome.purchaseId)).toEqual(['gate', 'intent', 'mandate_changed']);
});

it('sends the purchase to its buyer, after the intent check, when no saved wallet is linked', async () => {
  const s = await setUp({ wallet: 'pending' });

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toMatchObject({
    verdict: 'ASK',
    status: 'awaiting_approval',
    reasons: ['No saved PayPal wallet is linked'],
  });
  expect(s.intent.inputs).toHaveLength(1);
  expect(s.paypal.callsTo('createApprovalOrder')).toHaveLength(1);
});

it('lets exactly one of two concurrent proposals through when both exceed the remaining budget together', async () => {
  const s = await setUp();
  // $38.00 spent of the $60.00 budget leaves $22.00, room for one $18.00 proposal but not two.
  await addEarlierPurchase(s, 'accepted', 3800, EARLIER_THIS_MONTH);

  const outcomes = await Promise.all([propose(s, proposal(['GAR-200', 3])), propose(s, proposal(['GAR-200', 3]))]);

  const through = outcomes.filter((o) => o.verdict !== 'BLOCK');
  const blocked = outcomes.filter((o) => o.verdict === 'BLOCK');
  expect(through).toHaveLength(1);
  expect(through[0]).toMatchObject({ verdict: 'ALLOW', status: 'accepted' });
  expect(blocked).toEqual([
    {
      purchaseId: expect.any(String),
      verdict: 'BLOCK',
      status: 'blocked',
      reasons: ['$18.00 would exceed the $4.00 left this month'],
      approveUrl: null,
      receiptId: null,
    },
  ]);
  expect(s.paypal.captures).toHaveLength(1);
});

it('does not count blocked or refunded purchases against the budget', async () => {
  const s = await setUp();
  // Counted: one settled with the seller and one awaiting its buyer's approval, $38.00 together.
  await addEarlierPurchase(s, 'accepted', 2000, EARLIER_THIS_MONTH);
  await addEarlierPurchase(s, 'awaiting_approval', 1800, EARLIER_THIS_MONTH);
  // Never charged, or the money came back.
  for (const status of ['blocked', 'refunded', 'cancelled', 'failed'] as const) {
    await addEarlierPurchase(s, status, 5000, EARLIER_THIS_MONTH);
  }

  const outcome = await propose(s, proposal(['GAR-200', 3]));

  expect(outcome).toMatchObject({ verdict: 'ALLOW', status: 'accepted' });
  expect(await budgetDetail(s, outcome.purchaseId)).toBe('$18.00 fits in the $22.00 left this month');
});

it('counts only purchases made since the budget period began', async () => {
  const s = await setUp();
  await addEarlierPurchase(s, 'accepted', 3800, MONTH_START);
  await addEarlierPurchase(s, 'accepted', 5000, new Date(MONTH_START.getTime() - 1));

  const outcome = await propose(s, proposal(['GAR-200', 3]));

  expect(await budgetDetail(s, outcome.purchaseId)).toBe('$18.00 fits in the $22.00 left this month');
});

it('counts purchases still in flight, and no others, toward the velocity limit', async () => {
  const s = await setUp({ policy: { ...demoPolicy, velocity: { maxPurchases: 1, windowHours: 24 } } });
  await addEarlierPurchase(s, 'blocked', 900, hoursAgo(1));
  await addEarlierPurchase(s, 'accepted', 900, hoursAgo(25));

  const first = await propose(s, proposal(['TUR-100', 2]));
  const second = await propose(s, proposal(['TUR-100', 2]));

  expect(first).toMatchObject({ verdict: 'ALLOW', status: 'accepted' });
  expect(second).toMatchObject({
    verdict: 'BLOCK',
    status: 'blocked',
    reasons: ['Your limit of 1 purchase in 24 hours is already reached'],
  });
});

it.each([
  ['was revoked', { status: 'revoked' as const }, 'This mandate was revoked'],
  ['has expired', { expiresAt: hoursAgo(1) }, 'This mandate has expired'],
])('blocks a purchase when the buyer has no active mandate: one that %s', async (_, change, reason) => {
  const s = await setUp();
  await s.db.update(mandates).set(change).where(eq(mandates.id, s.mandateId));

  const outcome = await propose(s, proposal(['TUR-100', 2]));

  expect(outcome).toMatchObject({ verdict: 'BLOCK', status: 'blocked', reasons: [reason] });
  expect((await purchaseRow(s.db, outcome.purchaseId)).mandateId).toBe(s.mandateId);
  expect(s.intent.inputs).toEqual([]);
  expect(s.paypal.calls).toEqual([]);
});

it('records nothing for a buyer who never had a mandate', async () => {
  const s = await setUp();
  const [stranger] = await s.db.insert(buyers).values({ name: 'Sam' }).returning();

  await expect(
    proposePurchase(s.deps, { buyerId: stranger.id, runId: null, request: REQUEST, proposal: proposal(['TUR-100', 2]) }),
  ).rejects.toThrow(`buyer ${stranger.id} has no mandate`);
  expect(await s.db.select().from(purchases)).toEqual([]);
});

it('blocks a proposal naming a seller Behest does not know', async () => {
  const s = await setUp();

  const outcome = await propose(s, { ...proposal(['TUR-100', 2]), sellerSlug: 'nobody-here' });

  expect(outcome).toMatchObject({ verdict: 'BLOCK', status: 'blocked', reasons: ['SKU "TUR-100" is not sold by "nobody-here"'] });
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({ sellerId: null, cart: null, cartHash: null, totalCents: null });
});

it('blocks a proposal that is not valid', async () => {
  const s = await setUp();
  const invalid = { ...proposal(['TUR-100', 2]), items: [{ sku: 'TUR-100', quantity: 0 }] };

  const outcome = await propose(s, invalid);

  expect(outcome).toMatchObject({ verdict: 'BLOCK', status: 'blocked' });
  expect(outcome.reasons).toEqual([expect.stringMatching(/^The proposal is not valid at items\.0\.quantity: /)]);
  expect(await purchaseRow(s.db, outcome.purchaseId)).toMatchObject({ sellerId: null, proposal: invalid, cart: null });
});

it("locks the buyer's mandate row, and never the buyer row, before reading the spend", async () => {
  // PGlite runs one transaction at a time, so racing proposals cannot show the lock at work. The
  // statements the proposal sends, in order, show the lock is taken first and is the only one.
  const statements: string[] = [];
  const s = await setUp({ logQuery: (query) => statements.push(query) });
  statements.length = 0;

  await propose(s, proposal(['EAR-01', 1]));

  expect(statements[0]).toMatch(/^select .* from "mandates" where .*"mandates"\."status" = \$\d+.* for update$/);
  expect(statements.filter((q) => / for (no key update|update|share|key share)$/.test(q))).toEqual([statements[0]]);
  expect(statements.some((q) => q.includes('"buyers"'))).toBe(false);
  const spendRead = statements.findIndex((q) => /^select .*sum\(.*from "purchases"/.test(q));
  const insert = statements.findIndex((q) => q.startsWith('insert into "purchases"'));
  expect(spendRead).toBeGreaterThan(0);
  expect(insert).toBeGreaterThan(spendRead);
});

it('holds the mandate row FOR SHARE while it records the intent result', async () => {
  // A confirmation revoking the mandate updates its row, which a FOR SHARE lock makes wait, so the
  // mandate cannot end between the check that it is still active and the stored final verdict.
  const statements: string[] = [];
  const s = await setUp({ logQuery: (query) => statements.push(query) });
  statements.length = 0;

  await propose(s, proposal(['TUR-100', 2]));

  const share = statements.findIndex((q) => /^select .* from "mandates" where "mandates"\."id" = \$1 for share$/.test(q));
  const stored = statements.findIndex((q) => /^update "purchases" set .*"final_verdict" = /.test(q));
  expect(share).toBeGreaterThan(0);
  expect(stored).toBeGreaterThan(share);
});
