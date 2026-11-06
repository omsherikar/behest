import { expect, it } from 'vitest';
import { MandatePolicy } from '@/lib/domain/policy';
import { demoPolicy } from '@/tests/helpers/fixtures';

it('accepts the demo mandate policy', () => expect(MandatePolicy.safeParse(demoPolicy).success).toBe(true));
it('rejects a per-purchase max above the budget', () =>
  expect(MandatePolicy.safeParse({ ...demoPolicy, perPurchaseMaxCents: 7000 }).success).toBe(false));
it('rejects an ask threshold at or above the per-purchase max', () =>
  expect(MandatePolicy.safeParse({ ...demoPolicy, askAboveCents: 6000 }).success).toBe(false));
it('rejects a category both allowed and denied', () =>
  expect(MandatePolicy.safeParse({ ...demoPolicy, categories: { allow: ['spices'], deny: ['spices'] } }).success).toBe(false));
it('rejects non-USD', () => expect(MandatePolicy.safeParse({ ...demoPolicy, currency: 'INR' }).success).toBe(false));
it('rejects unknown keys', () => expect(MandatePolicy.safeParse({ ...demoPolicy, note: 'x' }).success).toBe(false));
it('rejects unknown keys inside nested objects', () =>
  expect(MandatePolicy.safeParse({ ...demoPolicy, budget: { ...demoPolicy.budget, rollover: true } }).success).toBe(false));
