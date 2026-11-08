'use client';

import { useSyncExternalStore } from 'react';
import { readStored, reduce, stored, TOUR_STORAGE_KEY, type TourAction, type TourState } from '@/lib/tour/state';

// The guided demo's state, kept in session storage so it survives a reload or a new page in the
// same tab, and shared by the start button and the tour controller. Where session storage is
// blocked (a private window, strict settings) it is kept in memory for the page's lifetime instead.

const listeners = new Set<() => void>();
let memory: string | null = null;
let snapshot: { raw: string | null; state: TourState } = { raw: null, state: null };

function readRaw(): string | null {
  try {
    return sessionStorage.getItem(TOUR_STORAGE_KEY);
  } catch {
    return memory;
  }
}

function writeRaw(raw: string | null) {
  memory = raw;
  try {
    if (raw === null) sessionStorage.removeItem(TOUR_STORAGE_KEY);
    else sessionStorage.setItem(TOUR_STORAGE_KEY, raw);
  } catch {
    // Kept in memory above.
  }
}

/** The current state; the same object until the stored value changes, as useSyncExternalStore needs. */
function current(): TourState {
  const raw = readRaw();
  if (raw !== snapshot.raw) snapshot = { raw, state: readStored(raw) };
  return snapshot.state;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchTour(action: TourAction): void {
  writeRaw(stored(reduce(current(), action)));
  for (const listener of listeners) listener();
}

export function startTour(): void {
  dispatchTour('start');
}

/** The tour's state; null on the server and while the tour is off. */
export function useTourState(): TourState {
  return useSyncExternalStore(subscribe, current, () => null);
}
