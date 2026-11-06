import { expect, it } from 'vitest';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { evaluateGate, type CatalogEntry, type GateInput, type GateResult } from '@/lib/gate/evaluate';
import type { RuleId } from '@/lib/gate/rules';

const NOW = new Date('2026-11-06T12:00:00Z');

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
