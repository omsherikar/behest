import { expect, it } from 'vitest';
import { MandatePolicy } from '@/lib/domain/policy';

const demo = {
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

it('accepts the demo mandate policy', () => expect(MandatePolicy.safeParse(demo).success).toBe(true));
it('rejects a per-purchase max above the budget', () =>
  expect(MandatePolicy.safeParse({ ...demo, perPurchaseMaxCents: 7000 }).success).toBe(false));
it('rejects an ask threshold at or above the per-purchase max', () =>
  expect(MandatePolicy.safeParse({ ...demo, askAboveCents: 6000 }).success).toBe(false));
it('rejects a category both allowed and denied', () =>
  expect(MandatePolicy.safeParse({ ...demo, categories: { allow: ['spices'], deny: ['spices'] } }).success).toBe(false));
it('rejects non-USD', () => expect(MandatePolicy.safeParse({ ...demo, currency: 'INR' }).success).toBe(false));
it('rejects unknown keys', () => expect(MandatePolicy.safeParse({ ...demo, note: 'x' }).success).toBe(false));
