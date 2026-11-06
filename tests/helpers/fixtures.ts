import type { MandatePolicy } from '@/lib/domain/policy';

// Fixtures shared by more than one test file.

/** The demo mandate: $60 a month on groceries and spices, ask above $25, never electronics. */
export const demoPolicy: MandatePolicy = {
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
