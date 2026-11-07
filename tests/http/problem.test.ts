import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { firstProblem } from '@/lib/http/problem';

const Body = z.object(
  { cart: z.object({ totalCents: z.number({ error: 'totalCents must be a number' }) }), note: z.string({ error: 'note must be text' }) },
  { error: 'Send JSON.' },
);

const problemWith = (value: unknown) => {
  const parsed = Body.safeParse(value);
  if (parsed.success) throw new Error('expected the value to fail');
  return firstProblem(parsed.error);
};

describe('firstProblem', () => {
  it('names the first issue with the path to it', () => {
    expect(problemWith({ cart: { totalCents: 'ten' }, note: 1 })).toBe('cart.totalCents: totalCents must be a number');
  });

  it('gives the message alone for an issue with the whole body', () => {
    expect(problemWith('not an object')).toBe('Send JSON.');
  });
});
