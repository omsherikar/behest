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
it('rejects a seller both allowed and denied', () => {
  const result = MandatePolicy.safeParse({
    ...demoPolicy,
    merchants: { allow: ['ravi-spices', 'cumin-co'], deny: ['cumin-co'] },
  });
  expect(result.success).toBe(false);
  expect(result.error?.issues).toEqual([
    expect.objectContaining({ path: ['merchants'], message: 'a seller cannot be both allowed and denied' }),
  ]);
});
it('accepts a seller allow list and a separate deny list', () =>
  expect(
    MandatePolicy.safeParse({ ...demoPolicy, merchants: { allow: ['ravi-spices'], deny: ['bad-shop'] } }).success,
  ).toBe(true));
it('rejects non-USD', () => expect(MandatePolicy.safeParse({ ...demoPolicy, currency: 'INR' }).success).toBe(false));
it('rejects unknown keys', () => expect(MandatePolicy.safeParse({ ...demoPolicy, note: 'x' }).success).toBe(false));
it('rejects unknown keys inside nested objects', () =>
  expect(MandatePolicy.safeParse({ ...demoPolicy, budget: { ...demoPolicy.budget, rollover: true } }).success).toBe(false));

const acceptsSellers = (merchants: unknown) => MandatePolicy.safeParse({ ...demoPolicy, merchants }).success;

it.each([
  ['a hyphenated slug', 'ravi-spices'],
  ['a one-character slug', 'a'],
  ['a slug starting with a digit', '7eleven'],
  ['a slug of 63 characters', 'a'.repeat(63)],
])('accepts %s as a seller', (_, slug) => {
  expect(acceptsSellers({ allow: [slug], deny: [] })).toBe(true);
  expect(acceptsSellers({ allow: null, deny: [slug] })).toBe(true);
});

it.each([
  ['a slug containing a comma and space', 'ravi-spices, bad-shop'],
  ['an upper-case slug', 'Ravi-Spices'],
  ['an empty slug', ''],
  ['a slug starting with a hyphen', '-ravi'],
  ['a slug containing a space', 'ravi spices'],
  ['a slug containing an underscore', 'ravi_spices'],
  ['a slug of 64 characters', 'a'.repeat(64)],
])('rejects %s as a seller', (_, slug) => {
  expect(acceptsSellers({ allow: [slug], deny: [] })).toBe(false);
  expect(acceptsSellers({ allow: null, deny: [slug] })).toBe(false);
});

const withExpiry = (expiresAt: string) => MandatePolicy.safeParse({ ...demoPolicy, expiresAt });

it.each(['2026-12-31T14:05:00Z', '2026-12-31T00:00:00Z', '2026-12-31T23:59:59.999Z'])(
  'accepts %s as an expiry',
  (expiresAt) => expect(withExpiry(expiresAt).success).toBe(true),
);

it.each(['2026-12-31T23:59:59Z', '2026-12-31T14:05:30Z', '2026-12-31T14:05:00.500Z', '2026-12-31T23:59:59.998Z'])(
  'rejects %s as an expiry, since it is neither a whole minute nor the end of a day',
  (expiresAt) => {
    const result = withExpiry(expiresAt);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['expiresAt'], message: 'expiresAt must be a whole minute or the end of a day' }),
    ]);
  },
);

it('rejects an expiry that is not a timestamp without throwing', () =>
  expect(withExpiry('not a date').success).toBe(false));
