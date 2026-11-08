import { describe, expect, it } from 'vitest';
import { NO_PINS, readPins } from '@/lib/tour/pins';

// TOUR_PINS names the records the guided demo opens by id. A missing or bad value must never break
// the site: it only leaves the steps that need that record without a ring.

const U1 = '0a1b2c3d-0000-4000-8000-000000000001';
const U2 = '0a1b2c3d-0000-4000-8000-000000000002';
const U3 = '0a1b2c3d-0000-4000-8000-000000000003';
const U4 = '0a1b2c3d-0000-4000-8000-000000000004';
const U5 = '0a1b2c3d-0000-4000-8000-000000000005';

describe('readPins', () => {
  it('reads every pin', () => {
    const ids = { allowed: U1, held: U2, blocked: U3, order: U4, dispute: U5 };
    expect(readPins(JSON.stringify(ids))).toEqual(ids);
  });

  it('keeps the valid pins and leaves the rest empty, ignoring keys it does not know', () => {
    expect(readPins(JSON.stringify({ allowed: U1, held: 'nope', blocked: 7, extra: U2 }))).toEqual({ ...NO_PINS, allowed: U1 });
  });

  it('has no pins when the setting is missing or not a JSON object', () => {
    for (const raw of [undefined, '', '   ', '{', '[]', 'null', '"x"', '42']) expect(readPins(raw)).toEqual(NO_PINS);
  });

  it('has an empty pin for every record the tour can show', () => {
    expect(NO_PINS).toEqual({ allowed: null, held: null, blocked: null, order: null, dispute: null });
  });
});
