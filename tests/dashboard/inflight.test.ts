import { describe, expect, it } from 'vitest';
import { createInflightLimiter } from '@/lib/inflight';

describe('in-flight limiter', () => {
  it('gives out at most `max` slots for a key', () => {
    const take = createInflightLimiter();

    const slots = Array.from({ length: 5 }, () => take('visitor', 4));

    expect(slots.filter(Boolean)).toHaveLength(4);
    expect(slots[4]).toBeNull();
  });

  it('counts each key on its own', () => {
    const take = createInflightLimiter();
    for (let i = 0; i < 4; i++) take('buyer', 4);

    expect(take('buyer', 4)).toBeNull();
    expect(take('seller', 4)).not.toBeNull();
  });

  it('frees a slot when it is released, once however often release is called', () => {
    const take = createInflightLimiter();
    const first = take('visitor', 2);
    take('visitor', 2);

    first?.();
    first?.();

    expect(take('visitor', 2)).not.toBeNull();
    expect(take('visitor', 2)).toBeNull();
  });
});
