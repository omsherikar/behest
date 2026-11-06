import { expect, it } from 'vitest';
import { maxVerdict } from '@/lib/domain/verdict';

it('maxVerdict orders BLOCK over ASK over ALLOW', () => {
  expect(maxVerdict('ALLOW', 'ASK')).toBe('ASK');
  expect(maxVerdict('ASK', 'BLOCK', 'ALLOW')).toBe('BLOCK');
  expect(maxVerdict('ALLOW')).toBe('ALLOW');
});

it('maxVerdict refuses an empty list rather than allowing', () => {
  expect(() => maxVerdict()).toThrow(/at least one verdict/);
});
