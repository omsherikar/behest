import { OPEN_PARAM } from '@/lib/ui/open-from-address';
import type { TourPins } from './pins';
import { TOUR_END, TOUR_STEPS, type TourStep } from './steps';

// Where the guided demo is, how it moves, and what each step opens and rings. The step index is
// kept in session storage, so a reload or a new page carries on where the judge was, in that tab
// only; anything unreadable there turns the tour off rather than throwing. A step whose pinned
// record is missing opens its page plainly, with nothing to ring, so the tour never breaks.

export const TOUR_STORAGE_KEY = 'behest-tour';

/** The index of the end card, after the last step. */
export const LAST_INDEX = TOUR_STEPS.length;

/** The step the judge is on, or null while the tour is off. */
export type TourState = { index: number } | null;
export type TourAction = 'start' | 'next' | 'back' | 'close';

export function reduce(state: TourState, action: TourAction): TourState {
  if (action === 'start') return { index: 0 };
  if (state === null || action === 'close') return null;
  if (action === 'next') return { index: Math.min(state.index + 1, LAST_INDEX) };
  return { index: Math.max(state.index - 1, 0) };
}

/** The step at an index: one of the steps, or the end card at LAST_INDEX. */
export function stepAt(index: number): TourStep {
  return index === LAST_INDEX ? TOUR_END : TOUR_STEPS[index];
}

/** The state kept in session storage, or null to remove the key. */
export function stored(state: TourState): string | null {
  return state === null ? null : JSON.stringify({ index: state.index });
}

/** The state read back from session storage: null for anything but a valid step index. */
export function readStored(raw: string | null): TourState {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { index } = value as { index?: unknown };
    return Number.isInteger(index) && (index as number) >= 0 && (index as number) <= LAST_INDEX ? { index: index as number } : null;
  } catch {
    return null;
  }
}

/** What a step opens and rings, with the pins filled in. */
export type TourTarget = {
  /** The address to open, with any `?open=` the step needs. */
  path: string;
  /** The `data-tour` anchor to ring, or null when there is nothing to point at. */
  anchor: string | null;
  /** The id of a grid row to scroll into view before ringing, or null. */
  rowId: string | null;
  /** Whether the record the step needs is not pinned on this site. */
  missing: boolean;
};

export function targetFor(step: TourStep, pins: TourPins): TourTarget {
  const needed = step.needs === undefined ? undefined : pins[step.needs];
  if (needed === null) {
    return { path: step.path.replace('/{dispute}', ''), anchor: null, rowId: null, missing: true };
  }
  const base = pins.dispute === null ? step.path : step.path.replace('{dispute}', pins.dispute);
  const open = step.open === undefined ? null : pins[step.open];
  return {
    path: open === null ? base : `${base}?${OPEN_PARAM}=${encodeURIComponent(open)}`,
    anchor: step.anchor,
    rowId: step.row === undefined ? null : pins[step.row],
    missing: false,
  };
}
