import { expect, it } from 'vitest';
import { PurchaseProposal } from '@/lib/domain/proposal';

const item = (quantity: number) => ({ sku: 'TUR-100', quantity });
const proposal = { sellerSlug: 'ravi-spices', items: [item(2)], rationale: 'Turmeric for the month' };

it('accepts a proposal at its limits', () =>
  expect(
    PurchaseProposal.safeParse({ ...proposal, items: Array.from({ length: 20 }, () => item(99)), rationale: 'r'.repeat(1000) })
      .success,
  ).toBe(true));

it.each([
  ['no items', { ...proposal, items: [] }],
  ['21 items', { ...proposal, items: Array.from({ length: 21 }, () => item(1)) }],
  ['a zero quantity', { ...proposal, items: [item(0)] }],
  ['a quantity of 100', { ...proposal, items: [item(100)] }],
  ['a fractional quantity', { ...proposal, items: [item(1.5)] }],
  ['a rationale over 1000 characters', { ...proposal, rationale: 'r'.repeat(1001) }],
  ['unknown keys', { ...proposal, priceCents: 1 }],
])('rejects %s', (_, input) => expect(PurchaseProposal.safeParse(input).success).toBe(false));
