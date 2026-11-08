import { z } from 'zod';

// The records the guided demo opens by id: the purchases it shows as allowed, held and blocked, the
// seller order whose receipt check it shows, and the dispute it walks through. They come from one
// deployment setting, TOUR_PINS, a JSON object of ids, set after the one real run on the live site.
// Pinning keeps the tour on those records however many purchases visitors make afterwards. A pin
// that is missing or not an id is left empty, and the steps that need it show their card without a
// ring; nothing here ever throws.

export const PIN_KEYS = ['allowed', 'held', 'blocked', 'order', 'dispute'] as const;
export type PinKey = (typeof PIN_KEYS)[number];
export type TourPins = Record<PinKey, string | null>;

export const NO_PINS: TourPins = { allowed: null, held: null, blocked: null, order: null, dispute: null };

const Id = z.guid();

/** The pins in TOUR_PINS, each the id it names or null. */
export function readPins(raw: string | undefined): TourPins {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? '');
  } catch {
    return NO_PINS;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return NO_PINS;
  const values = parsed as Record<string, unknown>;
  return Object.fromEntries(PIN_KEYS.map((key) => [key, Id.safeParse(values[key]).success ? (values[key] as string) : null])) as TourPins;
}
