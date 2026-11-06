import { expect, it } from 'vitest';
import type { BudgetPeriod, MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { evaluateGate, type CatalogEntry, type GateInput, type GateResult } from '@/lib/gate/evaluate';
import type { RuleId } from '@/lib/gate/rules';

const NOW = new Date('2026-11-06T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const demoPolicy: MandatePolicy = {
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

const listing = (
  sku: string,
  title: string,
  category: CatalogEntry['category'],
  priceCents: number,
  extra: Partial<CatalogEntry> = {},
): CatalogEntry => ({ sku, title, category, priceCents, stock: null, flags: [], marketMedianCents: null, ...extra });

const LISTINGS = [
  listing('TUR-100', 'Turmeric 100g', 'spices', 450),
  listing('CUM-100', 'Cumin 100g', 'spices', 375),
  listing('GAR-200', 'Garam masala 200g', 'spices', 600),
  listing('GIFT-SET', 'Spice gift set', 'spices', 4000),
  listing('SAF-1G', 'Kashmiri saffron 1g', 'spices', 1200, { flags: ['agent_instructions'] }),
  listing('EAR-01', 'Wireless earbuds', 'electronics', 2900),
  listing('BAS-1KG', 'Basmati rice 1kg', 'groceries', 900, { stock: 0 }),
];

/** The fixture catalog, with optional changes to one listing. */
const catalog = (sku?: string, changes: Partial<CatalogEntry> = {}) =>
  new Map(LISTINGS.map((l) => [l.sku, l.sku === sku ? { ...l, ...changes } : l]));

const proposal = (...items: [sku: string, quantity: number][]): PurchaseProposal => ({
  sellerSlug: 'ravi-spices',
  items: items.map(([sku, quantity]) => ({ sku, quantity })),
  rationale: 'Spices for the month',
});

const input = (overrides: Partial<GateInput> = {}): GateInput => ({
  policy: demoPolicy,
  mandate: { status: 'active', expiresAt: null },
  walletLinked: true,
  seller: { slug: 'ravi-spices', name: 'Ravi Spices' },
  proposal: proposal(['TUR-100', 2], ['CUM-100', 1], ['GAR-200', 1]),
  catalog: catalog(),
  spentInPeriodCents: 0,
  recentPurchaseTimes: [],
  now: NOW,
  ...overrides,
});

const outcome = (result: GateResult, rule: RuleId) => result.outcomes.find((o) => o.rule === rule);

it('allows $18.75 of spices', () => {
  const result = evaluateGate(input());
  expect(result.verdict).toBe('ALLOW');
  expect(result.rulesetVersion).toBe('gate-v1');
  expect(result.cart).toEqual({
    seller: { slug: 'ravi-spices', name: 'Ravi Spices' },
    currency: 'USD',
    items: [
      { sku: 'TUR-100', title: 'Turmeric 100g', category: 'spices', unitPriceCents: 450, quantity: 2 },
      { sku: 'CUM-100', title: 'Cumin 100g', category: 'spices', unitPriceCents: 375, quantity: 1 },
      { sku: 'GAR-200', title: 'Garam masala 200g', category: 'spices', unitPriceCents: 600, quantity: 1 },
    ],
    totalCents: 1875,
  });
  expect(outcome(result, 'cart_valid')).toEqual({
    rule: 'cart_valid',
    result: 'pass',
    detail: 'Every item is listed by Ravi Spices and in stock',
  });
});

it('prices the cart from the catalog as it is now', () => {
  const result = evaluateGate(input({ catalog: catalog('TUR-100', { priceCents: 500, title: 'Turmeric 100g (new crop)' }) }));
  expect(result.cart?.items[0]).toEqual({
    sku: 'TUR-100',
    title: 'Turmeric 100g (new crop)',
    category: 'spices',
    unitPriceCents: 500,
    quantity: 2,
  });
  expect(result.cart?.totalCents).toBe(1975);
});

it('blocks an unknown SKU and skips cart rules', () => {
  const result = evaluateGate(input({ proposal: proposal(['TUR-100', 1], ['NOPE-1', 1]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(result.cart).toBeNull();
  expect(outcome(result, 'cart_valid')).toEqual({
    rule: 'cart_valid',
    result: 'block',
    detail: 'NOPE-1 is not sold by Ravi Spices',
  });
  expect(outcome(result, 'category_allowed')).toEqual({
    rule: 'category_allowed',
    result: 'skip',
    detail: 'Not checked because the cart is not valid',
  });
});

it('blocks a catalog entry filed under another SKU', () => {
  const result = evaluateGate(input({ proposal: proposal(['TUR-200', 1]), catalog: new Map([['TUR-200', LISTINGS[0]]]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'cart_valid')?.detail).toBe('TUR-200 is not sold by Ravi Spices');
});

it('blocks when stock is short', () => {
  const outOfStock = evaluateGate(input({ proposal: proposal(['BAS-1KG', 1]) }));
  expect(outOfStock.verdict).toBe('BLOCK');
  expect(outOfStock.cart).toBeNull();
  expect(outcome(outOfStock, 'cart_valid')).toMatchObject({ result: 'block', detail: 'Basmati rice 1kg is out of stock' });

  const short = evaluateGate(input({ proposal: proposal(['TUR-100', 4]), catalog: catalog('TUR-100', { stock: 3 }) }));
  expect(short.verdict).toBe('BLOCK');
  expect(outcome(short, 'cart_valid')).toMatchObject({ result: 'block', detail: 'Turmeric 100g has only 3 in stock' });

  const exact = evaluateGate(input({ proposal: proposal(['TUR-100', 3]), catalog: catalog('TUR-100', { stock: 3 }) }));
  expect(outcome(exact, 'cart_valid')?.result).toBe('pass');
});

it('blocks a proposal for another seller', () => {
  const result = evaluateGate(input({ proposal: { ...proposal(['TUR-100', 1]), sellerSlug: 'other-shop' } }));
  expect(result.verdict).toBe('BLOCK');
  expect(result.cart).toBeNull();
  expect(outcome(result, 'cart_valid')?.detail).toBe('The proposal names a seller other than Ravi Spices');
});

it.each<[string, unknown, RegExp]>([
  [
    'a SKU split across two lines',
    proposal(['TUR-100', 1], ['TUR-100', 1]),
    /^The proposal is not valid at items: each SKU may appear only once$/,
  ],
  [
    'a price set by the agent',
    { ...proposal(), items: [{ sku: 'TUR-100', quantity: 1, unitPriceCents: 1 }] },
    /^The proposal is not valid at items\.0: .*unitPriceCents/,
  ],
  ['a zero quantity', proposal(['TUR-100', 0]), /^The proposal is not valid at items\.0\.quantity: \S/],
  ['no items', proposal(), /^The proposal is not valid at items: \S/],
  ['no proposal at all', null, /^The proposal is not valid: \S/],
])('blocks a proposal with %s', (_, malformed, detail) => {
  const result = evaluateGate(input({ proposal: malformed as PurchaseProposal }));
  expect(result.verdict).toBe('BLOCK');
  expect(result.cart).toBeNull();
  expect(outcome(result, 'cart_valid')).toMatchObject({ result: 'block', detail: expect.stringMatching(detail) });
});

it.each<[string, Partial<GateInput>, string]>([
  ['an expired mandate', { mandate: { status: 'expired', expiresAt: null } }, 'This mandate has expired'],
  ['a revoked mandate', { mandate: { status: 'revoked', expiresAt: null } }, 'This mandate was revoked'],
  ['a mandate expiring right now', { mandate: { status: 'active', expiresAt: NOW } }, 'This mandate has expired'],
  [
    'a policy that expired',
    { policy: { ...demoPolicy, expiresAt: '2026-11-06T11:59:59Z' } },
    'This mandate has expired',
  ],
])('blocks %s', (_, overrides, detail) => {
  const result = evaluateGate(input(overrides));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'mandate_active')).toEqual({ rule: 'mandate_active', result: 'block', detail });
  // The other rules are still evaluated, so the record shows everything that was wrong.
  expect(outcome(result, 'cart_valid')?.result).toBe('pass');
});

it('allows a mandate and policy that expire later', () => {
  const later = new Date(NOW.getTime() + 1);
  const result = evaluateGate(
    input({ mandate: { status: 'active', expiresAt: later }, policy: { ...demoPolicy, expiresAt: later.toISOString() } }),
  );
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'mandate_active')).toEqual({
    rule: 'mandate_active',
    result: 'pass',
    detail: 'The mandate is active and has not expired',
  });
});

it('blocks electronics', () => {
  const result = evaluateGate(input({ proposal: proposal(['EAR-01', 1]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'category_allowed')).toEqual({
    rule: 'category_allowed',
    result: 'block',
    detail: 'electronics is not allowed by your mandate',
  });
});

it.each<[string, MandatePolicy['categories'], string, string]>([
  ['outside the allow list', { allow: ['groceries'], deny: [] }, 'TUR-100', 'spices is not allowed by your mandate'],
  ['denied with no allow list', { allow: null, deny: ['spices'] }, 'TUR-100', 'spices is not allowed by your mandate'],
])('blocks a category %s', (_, categories, sku, detail) => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, categories }, proposal: proposal([sku, 1]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'category_allowed')).toMatchObject({ result: 'block', detail });
});

it('names a category in words', () => {
  const result = evaluateGate(
    input({
      policy: { ...demoPolicy, categories: { allow: null, deny: ['personal_care'] } },
      catalog: catalog('CUM-100', { category: 'personal_care' }),
    }),
  );
  expect(outcome(result, 'category_allowed')?.detail).toBe('personal care is not allowed by your mandate');
});

it('allows any category that is not denied when there is no allow list', () => {
  const result = evaluateGate(
    input({ policy: { ...demoPolicy, categories: { allow: null, deny: [] } }, proposal: proposal(['EAR-01', 1]) }),
  );
  expect(outcome(result, 'category_allowed')).toMatchObject({
    result: 'pass',
    detail: 'Every item is in a category your mandate allows',
  });
});

it.each<[string, MandatePolicy['merchants']]>([
  ['a denied seller', { allow: null, deny: ['ravi-spices'] }],
  ['a seller outside the allow list', { allow: ['other-shop'], deny: [] }],
])('blocks %s', (_, merchants) => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, merchants } }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'seller_allowed')).toEqual({
    rule: 'seller_allowed',
    result: 'block',
    detail: 'Ravi Spices is not allowed by your mandate',
  });
});

it('allows a seller on the allow list', () => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, merchants: { allow: ['ravi-spices'], deny: [] } } }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'seller_allowed')).toMatchObject({ result: 'pass', detail: 'Ravi Spices is allowed by your mandate' });
});

it('blocks a flagged listing', () => {
  const result = evaluateGate(input({ proposal: proposal(['TUR-100', 1], ['SAF-1G', 1]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'listing_clean')).toEqual({
    rule: 'listing_clean',
    result: 'block',
    detail: 'Kashmiri saffron 1g contains instructions aimed at AI agents',
  });
});

it('blocks a listing with any other screening flag', () => {
  const result = evaluateGate(input({ catalog: catalog('CUM-100', { flags: ['counterfeit'] }) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'listing_clean')).toMatchObject({
    result: 'block',
    detail: 'Cumin 100g was flagged by listing screening',
  });
});

it('passes listings with no screening flags', () => {
  expect(outcome(evaluateGate(input()), 'listing_clean')).toMatchObject({
    result: 'pass',
    detail: 'No item in the cart was flagged by listing screening',
  });
});

it('blocks over the per-purchase maximum', () => {
  const result = evaluateGate(
    input({ policy: { ...demoPolicy, perPurchaseMaxCents: 3000 }, proposal: proposal(['GIFT-SET', 1]) }),
  );
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'per_purchase_max')).toEqual({
    rule: 'per_purchase_max',
    result: 'block',
    detail: '$40.00 is over your $30.00 per-purchase limit',
  });
});

it('allows a total exactly at the per-purchase maximum', () => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, perPurchaseMaxCents: 1875, askAboveCents: null } }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'per_purchase_max')).toMatchObject({
    result: 'pass',
    detail: '$18.75 is within your $18.75 per-purchase limit',
  });
});

it('blocks when the period budget would be exceeded', () => {
  const result = evaluateGate(input({ spentInPeriodCents: 3800, proposal: proposal(['GIFT-SET', 1]) }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'budget_remaining')).toEqual({
    rule: 'budget_remaining',
    result: 'block',
    detail: '$40.00 would exceed the $22.00 left this month',
  });
});

it.each<[BudgetPeriod, string]>([
  ['day', '$40.00 would exceed the $22.00 left this day'],
  ['week', '$40.00 would exceed the $22.00 left this week'],
  ['once', '$40.00 would exceed the $22.00 left on this mandate'],
])('names the %s budget period', (period, detail) => {
  const result = evaluateGate(
    input({
      policy: { ...demoPolicy, budget: { amountCents: 6000, period } },
      spentInPeriodCents: 3800,
      proposal: proposal(['GIFT-SET', 1]),
    }),
  );
  expect(outcome(result, 'budget_remaining')?.detail).toBe(detail);
});

it('allows a total that uses exactly the budget left', () => {
  const result = evaluateGate(input({ spentInPeriodCents: 4125 }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'budget_remaining')).toMatchObject({
    result: 'pass',
    detail: '$18.75 fits in the $18.75 left this month',
  });
});

it('counts nothing as left once spend is over the budget', () => {
  const result = evaluateGate(input({ spentInPeriodCents: 7000 }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'budget_remaining')?.detail).toBe('$18.75 would exceed the $0.00 left this month');
});

it.each<[string, NonNullable<MandatePolicy['velocity']>, Date[], string]>([
  [
    'two purchases in a day',
    { maxPurchases: 2, windowHours: 24 },
    [hoursAgo(23), NOW],
    'Your limit of 2 purchases in 24 hours is already reached',
  ],
  [
    'one purchase an hour',
    { maxPurchases: 1, windowHours: 1 },
    [hoursAgo(0.5)],
    'Your limit of 1 purchase in 1 hour is already reached',
  ],
])('blocks over the velocity limit of %s', (_, limit, recentPurchaseTimes, detail) => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, velocity: limit }, recentPurchaseTimes }));
  expect(result.verdict).toBe('BLOCK');
  expect(outcome(result, 'velocity')).toEqual({ rule: 'velocity', result: 'block', detail });
});

it('counts only purchases strictly inside the velocity window', () => {
  const result = evaluateGate(
    input({
      policy: { ...demoPolicy, velocity: { maxPurchases: 2, windowHours: 24 } },
      recentPurchaseTimes: [hoursAgo(1), hoursAgo(24), hoursAgo(30)],
    }),
  );
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'velocity')).toMatchObject({
    result: 'pass',
    detail: 'Within your limit of 2 purchases in 24 hours',
  });
});

it('passes velocity when the mandate sets no limit', () => {
  const result = evaluateGate(input({ recentPurchaseTimes: [hoursAgo(1), hoursAgo(2), hoursAgo(3)] }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'velocity')).toMatchObject({
    result: 'pass',
    detail: 'Your mandate sets no limit on how often to buy',
  });
});

it('asks for a $40 gift set', () => {
  const result = evaluateGate(input({ proposal: proposal(['GIFT-SET', 1]) }));
  expect(result.verdict).toBe('ASK');
  expect(outcome(result, 'ask_threshold')).toEqual({
    rule: 'ask_threshold',
    result: 'ask',
    detail: '$40.00 is over your $25.00 approval limit',
  });
});

it('does not ask for a total exactly at the approval limit', () => {
  const result = evaluateGate(input({ policy: { ...demoPolicy, askAboveCents: 1875 } }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'ask_threshold')).toMatchObject({
    result: 'pass',
    detail: '$18.75 is within your $18.75 approval limit',
  });
});

it('never asks on amount alone when the mandate sets no approval limit', () => {
  const result = evaluateGate(
    input({ policy: { ...demoPolicy, askAboveCents: null }, proposal: proposal(['GIFT-SET', 1]) }),
  );
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'ask_threshold')).toMatchObject({
    result: 'pass',
    detail: 'Your mandate sets no approval limit on amount',
  });
});

it('asks when one SKU quantity is over 5', () => {
  const result = evaluateGate(input({ proposal: proposal(['TUR-100', 6]) }));
  expect(result.verdict).toBe('ASK');
  expect(result.cart?.totalCents).toBe(2700);
  expect(outcome(result, 'quantity')).toEqual({
    rule: 'quantity',
    result: 'ask',
    detail: 'Turmeric 100g has a quantity of 6, more than 5',
  });
  expect(outcome(result, 'ask_threshold')?.result).toBe('ask');
});

it('does not ask for a quantity of exactly 5', () => {
  const result = evaluateGate(input({ proposal: proposal(['TUR-100', 5]) }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'quantity')).toMatchObject({ result: 'pass', detail: 'No item has a quantity over 5' });
});

it('asks when price is over 1.5x the market median', () => {
  const result = evaluateGate(input({ catalog: catalog('TUR-100', { marketMedianCents: 250 }) }));
  expect(result.verdict).toBe('ASK');
  expect(outcome(result, 'price_benchmark')).toEqual({
    rule: 'price_benchmark',
    result: 'ask',
    detail: 'Turmeric 100g costs $4.50, more than 1.5 times its $2.50 market median',
  });
});

it('does not ask for a price exactly 1.5x the market median', () => {
  const result = evaluateGate(input({ catalog: catalog('TUR-100', { marketMedianCents: 300 }) }));
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'price_benchmark')).toMatchObject({
    result: 'pass',
    detail: 'Every benchmarked price is within 1.5 times its market median',
  });
});

it('skips the benchmark when no median exists', () => {
  const result = evaluateGate(input());
  expect(result.verdict).toBe('ALLOW');
  expect(outcome(result, 'price_benchmark')).toEqual({
    rule: 'price_benchmark',
    result: 'skip',
    detail: 'No market price benchmark exists for these items',
  });
});

it('asks when no wallet is linked', () => {
  const result = evaluateGate(input({ walletLinked: false }));
  expect(result.verdict).toBe('ASK');
  expect(outcome(result, 'wallet_linked')).toEqual({
    rule: 'wallet_linked',
    result: 'ask',
    detail: 'No saved PayPal wallet is linked',
  });
});

it('always reports all 12 rules in order', () => {
  const allowed = evaluateGate(input());
  expect(allowed.outcomes.map((o) => [o.rule, o.result])).toEqual([
    ['mandate_active', 'pass'],
    ['cart_valid', 'pass'],
    ['category_allowed', 'pass'],
    ['seller_allowed', 'pass'],
    ['listing_clean', 'pass'],
    ['per_purchase_max', 'pass'],
    ['budget_remaining', 'pass'],
    ['velocity', 'pass'],
    ['ask_threshold', 'pass'],
    ['price_benchmark', 'skip'],
    ['quantity', 'pass'],
    ['wallet_linked', 'pass'],
  ]);

  // Without a cart only the rules that do not need one are evaluated; the rest are skipped.
  const invalid = evaluateGate(input({ proposal: proposal(['NOPE-1', 1]), walletLinked: false }));
  expect(invalid.verdict).toBe('BLOCK');
  expect(invalid.outcomes.map((o) => [o.rule, o.result])).toEqual([
    ['mandate_active', 'pass'],
    ['cart_valid', 'block'],
    ['category_allowed', 'skip'],
    ['seller_allowed', 'skip'],
    ['listing_clean', 'skip'],
    ['per_purchase_max', 'skip'],
    ['budget_remaining', 'skip'],
    ['velocity', 'skip'],
    ['ask_threshold', 'skip'],
    ['price_benchmark', 'skip'],
    ['quantity', 'skip'],
    ['wallet_linked', 'ask'],
  ]);

  for (const { detail } of [...allowed.outcomes, ...invalid.outcomes]) {
    expect(detail).toMatch(/^\S.*\S$/);
    expect(detail).not.toContain('\u2014');
  }
});
