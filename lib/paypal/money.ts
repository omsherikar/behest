// PayPal takes amounts as decimal strings. Behest keeps money as integer cents, so this is the one
// place cents become a PayPal value.

/** 1875 cents becomes "18.75". */
export function toValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`An amount must be a whole, non-negative number of cents, not ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
