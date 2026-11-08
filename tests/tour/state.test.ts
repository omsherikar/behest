import { describe, expect, it } from 'vitest';
import { NO_PINS, type TourPins } from '@/lib/tour/pins';
import { LAST_INDEX, readStored, reduce, stepAt, stored, targetFor, TOUR_STORAGE_KEY } from '@/lib/tour/state';
import { TOUR_END, TOUR_STEPS, type TourStep } from '@/lib/tour/steps';

// Where the guided demo is, how it moves, and what each step opens and rings. The state lives in
// session storage, so a reload carries on; anything unreadable there turns the tour off.

const PINS: TourPins = {
  allowed: '0a1b2c3d-0000-4000-8000-000000000001',
  held: '0a1b2c3d-0000-4000-8000-000000000002',
  blocked: '0a1b2c3d-0000-4000-8000-000000000003',
  order: '0a1b2c3d-0000-4000-8000-000000000004',
  dispute: '0a1b2c3d-0000-4000-8000-000000000005',
};
const step = (id: string): TourStep => {
  const found = TOUR_STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
};

describe('reduce', () => {
  it('starts at the first step and closes to off', () => {
    expect(reduce(null, 'start')).toEqual({ index: 0 });
    expect(reduce({ index: 6 }, 'start')).toEqual({ index: 0 });
    expect(reduce({ index: 6 }, 'close')).toBeNull();
  });

  it('moves one step at a time, from the first step to the end card', () => {
    expect(reduce({ index: 3 }, 'next')).toEqual({ index: 4 });
    expect(reduce({ index: 3 }, 'back')).toEqual({ index: 2 });
    expect(reduce({ index: LAST_INDEX }, 'next')).toEqual({ index: LAST_INDEX });
    expect(reduce({ index: 0 }, 'back')).toEqual({ index: 0 });
  });

  it('does nothing while the tour is off, except start', () => {
    expect(reduce(null, 'next')).toBeNull();
    expect(reduce(null, 'back')).toBeNull();
    expect(reduce(null, 'close')).toBeNull();
  });
});

describe('stepAt', () => {
  it('gives the steps in order, then the end card', () => {
    expect(LAST_INDEX).toBe(TOUR_STEPS.length);
    expect(stepAt(0)).toBe(TOUR_STEPS[0]);
    expect(stepAt(LAST_INDEX)).toBe(TOUR_END);
  });
});

describe('session storage', () => {
  it('keeps the step under one key, and removes it when the tour closes', () => {
    expect(TOUR_STORAGE_KEY).toBe('behest-tour');
    expect(readStored(stored({ index: 3 }))).toEqual({ index: 3 });
    expect(readStored(stored({ index: LAST_INDEX }))).toEqual({ index: LAST_INDEX });
    expect(stored(null)).toBeNull();
  });

  it('turns the tour off for anything it cannot read', () => {
    for (const raw of [null, '', 'x', '{}', '[]', 'null', '{"index":-1}', '{"index":99}', '{"index":1.5}', '{"index":"2"}']) {
      expect(readStored(raw)).toBeNull();
    }
  });
});

describe('targetFor', () => {
  it('opens a public page with no role and rings its anchor', () => {
    expect(targetFor(step('welcome'), PINS)).toEqual({ path: '/', anchor: 'hero', rowId: null, missing: false });
  });

  it('opens a pinned record through ?open=', () => {
    expect(targetFor(step('held'), PINS)).toEqual({ path: `/buyer/ledger?open=${PINS.held}`, anchor: 'purchase-reasons', rowId: null, missing: false });
    expect(targetFor(step('receipt'), PINS)).toEqual({ path: `/seller/orders?open=${PINS.order}`, anchor: 'receipt-check', rowId: null, missing: false });
  });

  it('scrolls a pinned row into view', () => {
    expect(targetFor(step('ledger'), PINS)).toEqual({ path: `/buyer/ledger?row=${PINS.allowed}`, anchor: 'ledger-grid', rowId: PINS.allowed, missing: false });
    expect(targetFor(step('dispute'), PINS).path).toBe(`/ops/disputes?row=${PINS.dispute}`);
  });

  it('fills the dispute into its page', () => {
    expect(targetFor(step('answer'), PINS)).toEqual({ path: `/ops/disputes/${PINS.dispute}`, anchor: 'dispute-answer', rowId: null, missing: false });
  });

  it('shows the plain page, with nothing to ring, when the pin is missing', () => {
    expect(targetFor(step('held'), NO_PINS)).toEqual({ path: '/buyer/ledger', anchor: null, rowId: null, missing: true });
    expect(targetFor(step('ledger'), NO_PINS)).toEqual({ path: '/buyer/ledger', anchor: null, rowId: null, missing: true });
    expect(targetFor(step('answer'), NO_PINS)).toEqual({ path: '/ops/disputes', anchor: null, rowId: null, missing: true });
  });

  it('needs no pin for the end card', () => {
    expect(targetFor(TOUR_END, NO_PINS)).toEqual({ path: '/security', anchor: null, rowId: null, missing: false });
  });
});
