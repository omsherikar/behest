// In-memory counts of work in flight per key, such as the analyst's streamed replies per visitor.
// The daily spend cap is checked when a call starts, so calls running side by side can each pass
// it; a cap on how many run at once bounds how far past it they can go. Counts live in this
// server process only, which suits a single-instance demo.

/** Gives back a slot. Calling it again does nothing. */
export type Release = () => void;

/** A counter of slots per key. Tests make their own. */
export function createInflightLimiter() {
  const counts = new Map<string, number>();

  /** Takes a slot for `key` and returns its release, or returns null when `max` are taken. */
  return function takeSlot(key: string, max: number): Release | null {
    const taken = counts.get(key) ?? 0;
    if (taken >= max) return null;
    counts.set(key, taken + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (counts.get(key) ?? 1) - 1;
      if (left > 0) counts.set(key, left);
      else counts.delete(key);
    };
  };
}

/** The app's counter. */
export const takeSlot = createInflightLimiter();
