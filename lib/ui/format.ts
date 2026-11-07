// How the interface writes machine values: ids shortened for a glance, and console times.

/**
 * An id, hash or key short enough to scan: its first `head` and last `tail` characters around
 * "...", such as "7f3a9c2e...e21b". Values already that short come back whole. The full value
 * always stays available beside it, to read aloud and to copy.
 */
export function shortId(value: string, head = 8, tail = 4): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${tail > 0 ? value.slice(-tail) : ''}`;
}

/** A moment as the console's 24 hour UTC clock, such as "14:02:07". Null for an invalid date. */
export function consoleTime(at: Date | string): string | null {
  const date = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(11, 19);
}
