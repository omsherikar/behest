import { describe, expect, it } from 'vitest';
import { OPEN_PARAM, rowToOpen, withoutOpen } from '@/lib/ui/open-from-address';

// A grid opens a record's panel when the address names it with ?open=<id>, which is how the guided
// demo shows one pinned purchase or order, and drops the parameter when the panel closes.

describe('rowToOpen', () => {
  it('finds the row the address names', () => {
    expect(rowToOpen([{ id: 'a' }, { id: 'b' }], 'b')).toEqual({ id: 'b' });
  });

  it('opens nothing for a missing, empty or unknown id', () => {
    for (const open of [null, '', 'c']) expect(rowToOpen([{ id: 'a' }], open)).toBeNull();
  });
});

describe('withoutOpen', () => {
  it('drops only the open parameter', () => {
    expect(withoutOpen('?open=a&tab=b')).toBe('?tab=b');
    expect(withoutOpen('?tab=b&open=a')).toBe('?tab=b');
  });

  it('leaves no question mark when nothing else is left', () => {
    expect(withoutOpen('?open=a')).toBe('');
    expect(withoutOpen('')).toBe('');
  });
});

it('names the parameter open', () => {
  expect(OPEN_PARAM).toBe('open');
});
