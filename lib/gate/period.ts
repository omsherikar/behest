import type { BudgetPeriod } from '@/lib/domain/policy';

/**
 * The instant the current budget period began, so the gate can sum spend since then.
 * Periods are UTC calendar periods: a day starts at UTC midnight, a week on Monday at
 * UTC midnight, a month on the first at UTC midnight. A one-off budget starts when the
 * mandate was confirmed. Only UTC fields are read or written, so the answer never
 * depends on the server's time zone, and the inputs are never mutated.
 */
export function periodStart(period: BudgetPeriod, now: Date, confirmedAt: Date): Date {
  if (period === 'once') return new Date(confirmedAt.getTime());

  const start = new Date(now.getTime());
  start.setUTCHours(0, 0, 0, 0);
  switch (period) {
    case 'day':
      return start;
    case 'week': {
      const daysSinceMonday = (start.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - daysSinceMonday);
      return start;
    }
    case 'month':
      start.setUTCDate(1);
      return start;
  }
}
