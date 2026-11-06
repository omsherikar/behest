import { expect, it } from 'vitest';
import { toValue } from '@/lib/paypal/money';

it('writes integer cents as a PayPal amount value', () => {
  expect(toValue(1875)).toBe('18.75');
  expect(toValue(5)).toBe('0.05');
  expect(toValue(6000)).toBe('60.00');
  expect(toValue(0)).toBe('0.00');
  expect(toValue(123456)).toBe('1234.56');
});

it.each([18.75, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects %s cents', (cents) => {
  expect(() => toValue(cents)).toThrow(/cents/);
});
