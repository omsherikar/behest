import { expect, it } from 'vitest';
import { plural } from '@/lib/domain/words';

it('uses the singular for exactly one', () => expect(plural(1, 'hour')).toBe('1 hour'));
it('uses the plural for any other count', () => {
  expect(plural(0, 'purchase')).toBe('0 purchases');
  expect(plural(2, 'purchase')).toBe('2 purchases');
  expect(plural(24, 'hour')).toBe('24 hours');
});
