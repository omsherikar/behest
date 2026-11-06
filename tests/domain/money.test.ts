import { expect, it } from 'vitest';
import { formatUsd } from '@/lib/domain/money';

it('formats cents as dollars', () => {
  expect(formatUsd(450)).toBe('$4.50');
  expect(formatUsd(6000)).toBe('$60.00');
  expect(formatUsd(5)).toBe('$0.05');
});

it('groups thousands', () => expect(formatUsd(123456)).toBe('$1,234.56'));
