// Display formatting for integer cents, and reading an amount a person typed in dollars. Money
// stays in cents everywhere else.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** 450 becomes "$4.50". */
export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

/** The longest text read as an amount, far more than any price needs. */
const DOLLARS_TEXT_MAX = 32;
/**
 * An optional `$`, then whole dollars (plain digits, or digits grouped in threes by commas) with up
 * to two decimal places, or the decimal places alone. Every part matches different characters, so
 * it runs in linear time.
 */
const DOLLARS = /^\$?\s*(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/;

/**
 * Whole cents from an amount typed in dollars, such as `4.50`, `$12` or `1,234.5`, or null when the
 * text is not a plain amount or is too large to count in cents exactly. The cents are read from the
 * digits as text, never by multiplying a float by 100, which turns 4.35 into 434.99999999999994.
 * Zero reads as 0; a caller that needs a price checks that it is positive.
 */
export function dollarsToCents(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length > DOLLARS_TEXT_MAX) return null;
  const match = DOLLARS.exec(trimmed);
  if (!match) return null;
  const whole = (match[1] ?? '0').replaceAll(',', '');
  const fraction = (match[2] ?? match[3] ?? '').padEnd(2, '0');
  const cents = Number(`${whole}${fraction}`);
  return Number.isSafeInteger(cents) ? cents : null;
}
