// Display formatting for integer cents. Money stays in cents everywhere else.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** 450 becomes "$4.50". */
export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}
