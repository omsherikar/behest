// PayPal takes and sends amounts as decimal strings. Behest keeps money as integer cents, so this is
// the one place cents become a PayPal value and a PayPal value becomes cents.

/** 1875 cents becomes "18.75". */
export function toValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`An amount must be a whole, non-negative number of cents, not ${cents}`);
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "18.75" becomes 1875 cents. Only a plain, non-negative value with at most two decimals is read. */
export function toCents(value: string): number {
  const match = typeof value === 'string' ? /^(\d+)(?:\.(\d{1,2}))?$/.exec(value) : null;
  const cents = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : Number.NaN;
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`An amount value must be a non-negative number with at most two decimals, not ${JSON.stringify(value)}`);
  }
  return cents;
}
