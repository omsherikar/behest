import { describe, expect, it } from 'vitest';
import { dollarsToCents, formatUsd } from '@/lib/domain/money';

it('formats cents as dollars', () => {
  expect(formatUsd(450)).toBe('$4.50');
  expect(formatUsd(6000)).toBe('$60.00');
  expect(formatUsd(5)).toBe('$0.05');
});

it('groups thousands', () => expect(formatUsd(123456)).toBe('$1,234.56'));

describe('dollarsToCents', () => {
  it('reads dollars with up to two decimal places', () => {
    expect(dollarsToCents('4.50')).toBe(450);
    expect(dollarsToCents('4.5')).toBe(450);
    expect(dollarsToCents('4')).toBe(400);
    expect(dollarsToCents('0.05')).toBe(5);
    expect(dollarsToCents('.75')).toBe(75);
    expect(dollarsToCents('012.00')).toBe(1200);
  });

  it('is exact for amounts that multiplying a float by 100 gets wrong', () => {
    // In floating point 4.35 * 100 is 434.99999999999994, 1.15 * 100 is 114.99999999999999 and
    // 0.29 * 100 is 28.999999999999996.
    expect(dollarsToCents('4.35')).toBe(435);
    expect(dollarsToCents('1.15')).toBe(115);
    expect(dollarsToCents('0.29')).toBe(29);
    expect(dollarsToCents('19.99')).toBe(1999);
  });

  it('accepts a dollar sign, surrounding spaces and thousands separators', () => {
    expect(dollarsToCents('$12.00')).toBe(1200);
    expect(dollarsToCents('$ 12')).toBe(1200);
    expect(dollarsToCents('  12.5  ')).toBe(1250);
    expect(dollarsToCents('1,234.50')).toBe(123450);
    expect(dollarsToCents('$1,000,000')).toBe(100000000);
  });

  it('reads zero as zero cents, leaving the caller to require a positive price', () => {
    expect(dollarsToCents('0')).toBe(0);
    expect(dollarsToCents('0.00')).toBe(0);
  });

  it('refuses text that is not a plain dollar amount', () => {
    for (const text of [
      '',
      '  ',
      '$',
      '.',
      '4.',
      'abc',
      '4.505',
      '-4',
      '+4',
      '4,50',
      '1,23.00',
      '12,3456',
      '4.5.0',
      '4. 50',
      '1e3',
      '0x10',
      'Infinity',
      'NaN',
      '4.50 USD',
      '4$',
    ]) {
      expect(dollarsToCents(text), text).toBeNull();
    }
  });

  it('refuses an amount too large to hold as an exact whole number of cents', () => {
    expect(dollarsToCents('9'.repeat(20))).toBeNull();
    expect(dollarsToCents(`1${'0'.repeat(40)}`)).toBeNull();
  });
});
