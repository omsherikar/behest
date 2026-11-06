import { expect, it } from 'vitest';
import { toCents, toValue } from '@/lib/paypal/money';

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

it('reads a PayPal amount value as integer cents', () => {
  expect(toCents('18.75')).toBe(1875);
  expect(toCents('5')).toBe(500);
  expect(toCents('0.05')).toBe(5);
  expect(toCents('60.0')).toBe(6000);
  expect(toCents('0')).toBe(0);
  expect(toCents('1234.56')).toBe(123456);
});

it('reads the largest amount value that is a safe number of cents', () => {
  expect(toCents('90071992547409.91')).toBe(9007199254740991);
});

it.each(['-1.00', '-0.05', '1.234', '18.750', 'abc', '', ' 5', '5 ', '.5', '5.', '+5', '1e3', '1,000.00', 'NaN', '90071992547409.92'])(
  'rejects the amount value "%s"',
  (value) => {
    expect(() => toCents(value)).toThrow(/amount value/);
  },
);
