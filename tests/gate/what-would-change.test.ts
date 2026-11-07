import { describe, expect, it } from 'vitest';
import { MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { evaluateGateSafely, type CatalogEntry, type GateInput } from '@/lib/gate/evaluate';
import { whatWouldChange, type MandateChange, type WhatWouldChange } from '@/lib/gate/what-would-change';
import { demoPolicy } from '@/tests/helpers/fixtures';

// The demo policy: $60.00 a month, $60.00 a purchase, ask above $25.00, groceries and spices only,
// never electronics, any seller, no limit on how often, no expiry.

const NOW = new Date('2026-11-06T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

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
  listing('ODD-1', 'Odd listing', 'spices', 500, { flags: ['suspicious'] }),
  listing('EAR-01', 'Wireless earbuds', 'electronics', 2900),
  listing('TEA-1', 'Assam tea', 'beverages', 800),
  listing('BAS-1KG', 'Basmati rice 1kg', 'groceries', 900, { stock: 0 }),
];

const catalog = (sku?: string, changes: Partial<CatalogEntry> = {}) =>
  new Map(LISTINGS.map((l) => [l.sku, l.sku === sku ? { ...l, ...changes } : l]));

const proposal = (...items: [sku: string, quantity: number][]): PurchaseProposal => ({
  sellerSlug: 'ravi-spices',
  items: items.map(([sku, quantity]) => ({ sku, quantity })),
  rationale: 'For the kitchen',
});

/** $18.75 of spices, which the demo policy allows. */
const input = (overrides: Partial<GateInput> = {}, policy: Partial<MandatePolicy> = {}): GateInput => ({
  policy: { ...demoPolicy, ...policy },
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

const giftSet = (overrides: Partial<GateInput> = {}, policy: Partial<MandatePolicy> = {}) =>
  input({ proposal: proposal(['GIFT-SET', 1]), ...overrides }, policy);

/** The changes' texts and outcomes, or the answer's kind when it has none. */
const summary = (answer: WhatWouldChange) =>
  answer.kind === 'changes' ? answer.changes.map((c) => [c.text, c.outcome]) : answer.kind;

/** The gate's verdict once a change is made to the input it was found for. */
const verdictAfter = (base: GateInput, change: MandateChange) =>
  evaluateGateSafely({ ...base, policy: change.policy, walletLinked: change.walletLinked }).verdict;

describe('whatWouldChange', () => {
  describe('when the gate already allows the purchase', () => {
    it('has nothing to change', () => {
      expect(whatWouldChange(input())).toEqual({ kind: 'allowed' });
    });

    it('can only be approved when the intent check asked the buyer', () => {
      for (const intent of ['needs_human', 'unavailable'] as const) {
        expect(whatWouldChange(input(), intent)).toEqual({ kind: 'changes', approve: true, changes: [], together: false });
      }
      expect(whatWouldChange(input(), 'consistent')).toEqual({ kind: 'allowed' });
    });
  });

  describe('for a purchase held for the buyer', () => {
    it('offers approving at PayPal, then raising the approval limit, then removing it', () => {
      const answer = whatWouldChange(giftSet());
      expect(answer).toMatchObject({ kind: 'changes', approve: true, together: false });
      expect(summary(answer)).toEqual([
        ['Raise your approval limit to $40.00', 'ALLOW'],
        ['Stop asking you about purchases on their amount alone', 'ALLOW'],
      ]);
    });

    it('suggests linking a wallet when that is what asked', () => {
      expect(summary(whatWouldChange(input({ walletLinked: false })))).toEqual([['Link your PayPal wallet', 'ALLOW']]);
    });

    it('needs every change together when two rules asked', () => {
      const answer = whatWouldChange(giftSet({ walletLinked: false }));
      expect(answer).toMatchObject({ kind: 'changes', approve: true, together: true });
      expect(summary(answer)).toEqual([
        ['Link your PayPal wallet', 'ALLOW'],
        ['Raise your approval limit to $40.00', 'ALLOW'],
      ]);
    });

    it('has no mandate change for a price far above the market or a large quantity', () => {
      const pricey = input({ catalog: catalog('GAR-200', { marketMedianCents: 300 }) });
      const bulk = input({ proposal: proposal(['TUR-100', 6]) });
      for (const held of [pricey, bulk]) {
        expect(whatWouldChange(held)).toEqual({ kind: 'changes', approve: true, changes: [], together: false });
      }
    });

    it('can only be approved when the intent check asked too, whatever the gate said', () => {
      expect(whatWouldChange(giftSet(), 'needs_human')).toEqual({ kind: 'changes', approve: true, changes: [], together: false });
    });
  });

  describe('for a blocked purchase', () => {
    it('raises the per-purchase limit to the total', () => {
      const answer = whatWouldChange(giftSet({}, { perPurchaseMaxCents: 3000, askAboveCents: null }));
      expect(answer).toMatchObject({ kind: 'changes', approve: false, together: false });
      expect(summary(answer)).toEqual([['Raise your per-purchase limit to $40.00', 'ALLOW']]);
    });

    it('raises the budget by what the purchase needs', () => {
      const answer = whatWouldChange(input({ spentInPeriodCents: 5000 }));
      expect(summary(answer)).toEqual([['Raise your monthly budget by $8.75, to $68.75', 'ALLOW']]);
    });

    it('names the budget period', () => {
      const answer = whatWouldChange(input({ spentInPeriodCents: 5000 }, { budget: { amountCents: 6000, period: 'week' } }));
      expect(summary(answer)).toEqual([['Raise your weekly budget by $8.75, to $68.75', 'ALLOW']]);
    });

    it('allows a denied category', () => {
      const answer = whatWouldChange(input({ proposal: proposal(['EAR-01', 1]) }, { askAboveCents: null }));
      expect(summary(answer)).toEqual([['Allow the category electronics', 'ALLOW']]);
      if (answer.kind !== 'changes') throw new Error('expected changes');
      expect(answer.changes[0].policy.categories).toEqual({ allow: ['groceries', 'spices', 'electronics'], deny: [] });
    });

    it('allows a category the allow list leaves out', () => {
      const answer = whatWouldChange(input({ proposal: proposal(['TEA-1', 1]) }));
      expect(summary(answer)).toEqual([['Allow the category beverages', 'ALLOW']]);
    });

    it('allows every refused category in one change', () => {
      const answer = whatWouldChange(input({ proposal: proposal(['TEA-1', 1], ['EAR-01', 1]) }, { askAboveCents: null }));
      expect(summary(answer)).toEqual([['Allow the categories beverages and electronics', 'ALLOW']]);
    });

    it('removes a blocked seller, or adds one the allow list leaves out', () => {
      const blocked = whatWouldChange(input({}, { merchants: { allow: null, deny: ['ravi-spices'] } }));
      expect(summary(blocked)).toEqual([['Remove Ravi Spices from your blocked sellers', 'ALLOW']]);
      const unlisted = whatWouldChange(input({}, { merchants: { allow: ['other-shop'], deny: [] } }));
      expect(summary(unlisted)).toEqual([['Add Ravi Spices to your allowed sellers', 'ALLOW']]);
    });

    it('raises the limit on how often before removing it', () => {
      const answer = whatWouldChange(
        input({ recentPurchaseTimes: [hoursAgo(1), hoursAgo(2), hoursAgo(30)] }, { velocity: { maxPurchases: 2, windowHours: 24 } }),
      );
      expect(summary(answer)).toEqual([
        ['Allow 3 purchases in 24 hours', 'ALLOW'],
        ['Remove the limit on how often your agent buys', 'ALLOW'],
      ]);
    });

    it('makes changes together when no single one is enough', () => {
      // $40.00 is over the $30.00 per-purchase limit and the $25.00 approval limit, and the
      // approval limit has to stay below the per-purchase limit.
      const answer = whatWouldChange(giftSet({}, { perPurchaseMaxCents: 3000 }));
      expect(answer).toMatchObject({ kind: 'changes', approve: false, together: true });
      expect(summary(answer)).toEqual([
        ['Raise your per-purchase limit to $40.00', 'ALLOW'],
        ['Stop asking you about purchases on their amount alone', 'ALLOW'],
      ]);
    });

    it('raises the budget along with a per-purchase limit above it', () => {
      const answer = whatWouldChange(
        giftSet({}, { budget: { amountCents: 3000, period: 'month' }, perPurchaseMaxCents: 3000, askAboveCents: null }),
      );
      expect(answer).toMatchObject({ together: true });
      expect(summary(answer)).toEqual([
        ['Raise your per-purchase limit to $40.00', 'ALLOW'],
        ['Raise your monthly budget by $10.00, to $40.00', 'ALLOW'],
      ]);
    });

    it('says when a change would still need the buyer to approve', () => {
      // A category change lets the earbuds through to the price benchmark, which still asks.
      const answer = whatWouldChange(
        input({ proposal: proposal(['EAR-01', 1]), catalog: catalog('EAR-01', { marketMedianCents: 1000 }) }, { askAboveCents: null }),
      );
      expect(answer).toMatchObject({ kind: 'changes', approve: false, together: false });
      expect(summary(answer)).toEqual([['Allow the category electronics', 'ASK']]);
    });
  });

  describe('never suggests a change', () => {
    it('for a listing flagged for instructions aimed at AI agents', () => {
      expect(whatWouldChange(input({ proposal: proposal(['SAF-1G', 1]) }))).toEqual({
        kind: 'cannot',
        reason: 'Kashmiri saffron 1g contains instructions aimed at AI agents.',
      });
    });

    it('for a flagged listing even when other rules could be changed', () => {
      const answer = whatWouldChange(input({ proposal: proposal(['SAF-1G', 1], ['GIFT-SET', 1]) }, { perPurchaseMaxCents: 3000 }));
      expect(answer.kind).toBe('cannot');
    });

    it('for a listing flagged for anything else', () => {
      expect(whatWouldChange(input({ proposal: proposal(['ODD-1', 1]) }))).toEqual({
        kind: 'cannot',
        reason: 'Odd listing was flagged by listing screening.',
      });
    });

    it('for a mandate that has expired or was revoked', () => {
      expect(whatWouldChange(giftSet({ mandate: { status: 'expired', expiresAt: null } }))).toEqual({
        kind: 'cannot',
        reason: 'This mandate has expired.',
      });
      expect(whatWouldChange(giftSet({ mandate: { status: 'revoked', expiresAt: null } }))).toEqual({
        kind: 'cannot',
        reason: 'This mandate was revoked.',
      });
      expect(whatWouldChange(giftSet({ mandate: { status: 'active', expiresAt: hoursAgo(1) } })).kind).toBe('cannot');
      expect(whatWouldChange(giftSet({}, { expiresAt: '2026-11-01T00:00:00.000Z' })).kind).toBe('cannot');
    });

    it('for a cart that is not real', () => {
      expect(whatWouldChange(input({ proposal: proposal(['BAS-1KG', 1]) }))).toEqual({
        kind: 'cannot',
        reason: 'Basmati rice 1kg is out of stock.',
      });
      expect(whatWouldChange(input({ proposal: proposal(['NOPE-1', 1]) })).kind).toBe('cannot');
    });

    it('for a cart the intent check found does not match the request', () => {
      expect(whatWouldChange(input(), 'inconsistent')).toEqual({
        kind: 'cannot',
        reason: 'The intent check found that this cart does not match what you asked for.',
      });
    });
  });

  describe('every suggestion', () => {
    const scenarios: GateInput[] = [
      giftSet(),
      giftSet({ walletLinked: false }),
      giftSet({}, { perPurchaseMaxCents: 3000 }),
      giftSet({}, { perPurchaseMaxCents: 3000, askAboveCents: null }),
      giftSet({}, { budget: { amountCents: 3000, period: 'month' }, perPurchaseMaxCents: 3000, askAboveCents: null }),
      input({ spentInPeriodCents: 5000 }),
      input({ proposal: proposal(['EAR-01', 1]) }),
      input({ proposal: proposal(['TEA-1', 1], ['EAR-01', 1]) }),
      input({}, { merchants: { allow: null, deny: ['ravi-spices'] } }),
      input({ recentPurchaseTimes: [hoursAgo(1), hoursAgo(2)] }, { velocity: { maxPurchases: 2, windowHours: 24 } }),
      input({ walletLinked: false, spentInPeriodCents: 5900 }),
    ];

    it.each(scenarios.map((scenario, index) => [index, scenario] as const))('in scenario %i leaves a valid policy with the outcome it claims', (_, scenario) => {
      const answer = whatWouldChange(scenario);
      expect(answer.kind).toBe('changes');
      if (answer.kind !== 'changes') return;
      expect(answer.changes.length).toBeGreaterThan(0);
      for (const change of answer.changes) expect(MandatePolicy.safeParse(change.policy).success).toBe(true);
      // A set of changes carries the policy with all of them made, so each one checks the whole set.
      for (const change of answer.changes) expect(verdictAfter(scenario, change)).toBe(change.outcome);
      if (answer.together) expect(new Set(answer.changes.map((c) => JSON.stringify(c.policy))).size).toBe(1);
    });

    it('never loosens anything the buyer did not need loosened', () => {
      const answer = whatWouldChange(input({ spentInPeriodCents: 5000 }));
      if (answer.kind !== 'changes') throw new Error('expected changes');
      const { budget, ...rest } = answer.changes[0].policy;
      const { budget: before, ...unchanged } = demoPolicy;
      expect(rest).toEqual(unchanged);
      expect(budget.amountCents).toBeGreaterThan(before.amountCents);
    });
  });
});
