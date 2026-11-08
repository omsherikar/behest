import { describe, expect, it } from 'vitest';
import { GUTTER, placeCard, RING_GAP } from '@/lib/tour/place';

// Where the guided demo's card goes: next to the ring, wherever it fits, inside the window; docked
// to the bottom on a phone; in the bottom right corner when there is nothing to ring or no room.

const CARD = { width: 400, height: 220 };
const WINDOW = { width: 1440, height: 900 };

describe('placeCard', () => {
  it('goes below the ring when it fits there, lined up with its left edge', () => {
    expect(placeCard({ top: 100, left: 200, width: 600, height: 300 }, CARD, WINDOW)).toEqual({ top: 400 + RING_GAP, left: 200 });
  });

  it('goes above when there is no room below', () => {
    expect(placeCard({ top: 500, left: 200, width: 600, height: 350 }, CARD, WINDOW)).toEqual({ top: 500 - RING_GAP - 220, left: 200 });
  });

  it('goes beside when there is no room above or below', () => {
    expect(placeCard({ top: 60, left: 100, width: 700, height: 780 }, CARD, WINDOW)).toEqual({ top: 60, left: 800 + RING_GAP });
    expect(placeCard({ top: 60, left: 700, width: 700, height: 780 }, CARD, WINDOW)).toEqual({ top: 60, left: 700 - RING_GAP - 400 });
  });

  it('stays inside the window', () => {
    expect(placeCard({ top: 100, left: 1300, width: 120, height: 40 }, CARD, WINDOW)).toEqual({ top: 140 + RING_GAP, left: 1440 - GUTTER - 400 });
    expect(placeCard({ top: 100, left: -50, width: 120, height: 40 }, CARD, WINDOW)).toEqual({ top: 140 + RING_GAP, left: GUTTER });
  });

  it('goes to the bottom right corner when nothing is ringed or nothing fits', () => {
    const corner = { top: 900 - GUTTER - 220, left: 1440 - GUTTER - 400 };
    expect(placeCard(null, CARD, WINDOW)).toEqual(corner);
    expect(placeCard({ top: 10, left: 10, width: 1420, height: 880 }, CARD, WINDOW)).toEqual(corner);
  });

  it('docks to the bottom on a narrow screen', () => {
    expect(placeCard({ top: 100, left: 20, width: 300, height: 100 }, CARD, { width: 390, height: 844 })).toBe('docked');
  });
});
