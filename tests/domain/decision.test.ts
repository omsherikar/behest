import { expect, it } from 'vitest';
import { DecisionRecord } from '@/lib/domain/decision';

const hash = 'a'.repeat(64);
const listing = { sellerSlug: 'ravi-spices', sku: 'TUR-100', priceCents: 450, stock: 40, titleHash: hash };

const record: DecisionRecord = {
  v: 1,
  runId: 'run-1',
  steps: [
    { tool: 'search_sellers', input: { query: 'turmeric', category: 'spices', maxPriceCents: 1000 }, listings: [listing] },
    { tool: 'search_market', input: { query: 'turmeric 100g' }, results: [{ titleHash: hash, medianPriceCents: 500, cheapestCents: 480 }] },
    { tool: 'search_market', input: { query: 'saffron' }, results: null },
    { tool: 'get_product', input: { sellerSlug: 'ravi-spices', sku: 'TUR-100' }, listing },
    { tool: 'get_product', input: { sellerSlug: 'ravi-spices', sku: 'NONE' }, listing: null },
  ],
  choice: { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 1 }] },
  rationale: 'Turmeric is what the buyer asked for.',
};

it('accepts a record of searches, lookups, the choice and the rationale', () => {
  expect(DecisionRecord.parse(record)).toEqual(record);
  expect(DecisionRecord.safeParse({ ...record, steps: [] }).success).toBe(true);
  expect(DecisionRecord.safeParse({ ...record, steps: [{ tool: 'search_sellers', input: { query: '' }, listings: [] }] }).success).toBe(true);
});

it.each([
  ['a listing that keeps its title', { ...record, steps: [{ ...record.steps[0], listings: [{ ...listing, title: 'Turmeric' }] }] }],
  ['a title hash that is not sha256 hex', { ...record, steps: [{ ...record.steps[0], listings: [{ ...listing, titleHash: 'abc' }] }] }],
  ['a market result that keeps its title', { ...record, steps: [{ ...record.steps[1], results: [{ title: 'x', medianPriceCents: 1, cheapestCents: 1 }] }] }],
  ['a tool the agent does not have', { ...record, steps: [{ tool: 'propose_purchase', input: {} }] }],
  ['another version', { ...record, v: 2 }],
  ['no choice', { ...record, choice: undefined }],
  ['a choice with no items', { ...record, choice: { sellerSlug: 'ravi-spices', items: [] } }],
  ['unknown keys', { ...record, note: 'x' }],
])('rejects a record with %s', (_, input) => expect(DecisionRecord.safeParse(input).success).toBe(false));
