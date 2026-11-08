// Where the guided demo's card goes. Next to the ring, trying below, above, right and left in that
// order, kept inside the window; in the bottom right corner when nothing is ringed or nothing fits;
// docked along the bottom of a narrow screen, where there is no room beside anything.

/** The space kept between the card and the window's edges, in CSS pixels. */
export const GUTTER = 16;
/** The space between the ring and the card. */
export const RING_GAP = 14;
/** Below this window width the card docks to the bottom. */
export const NARROW = 640;

export type Box = { top: number; left: number; width: number; height: number };
export type Size = { width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placeCard(ring: Box | null, card: Size, window: Size): { top: number; left: number } | 'docked' {
  if (window.width < NARROW) return 'docked';
  const maxTop = window.height - GUTTER - card.height;
  const maxLeft = window.width - GUTTER - card.width;
  const corner = { top: maxTop, left: maxLeft };
  if (ring === null) return corner;

  const bottom = ring.top + ring.height;
  const right = ring.left + ring.width;
  const alongside = clamp(ring.left, GUTTER, maxLeft);
  const level = clamp(ring.top, GUTTER, maxTop);

  if (bottom + RING_GAP + card.height <= window.height - GUTTER) return { top: bottom + RING_GAP, left: alongside };
  if (ring.top - RING_GAP - card.height >= GUTTER) return { top: ring.top - RING_GAP - card.height, left: alongside };
  if (right + RING_GAP + card.width <= window.width - GUTTER) return { top: level, left: right + RING_GAP };
  if (ring.left - RING_GAP - card.width >= GUTTER) return { top: level, left: ring.left - RING_GAP - card.width };
  return corner;
}
