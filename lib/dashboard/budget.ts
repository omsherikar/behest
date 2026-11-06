import type { PurchaseStatus } from '@/lib/db/schema';
import type { BudgetPeriod } from '@/lib/domain/policy';

// Budget burn-down for the dashboard: how much of a mandate's budget the current period has used.
// It counts purchases the way the gate's budget rule does, every status except blocked, cancelled,
// failed and refunded, and splits them into money already captured and reservations still in
// flight (proposed, being charged or waiting for the buyer's approval).

/** How a purchase in a given status weighs on the budget. */
export type BudgetEffect = 'spent' | 'in_flight' | 'released';

const EFFECT: Record<PurchaseStatus, BudgetEffect> = {
  proposed: 'in_flight',
  charging: 'in_flight',
  awaiting_approval: 'in_flight',
  captured: 'spent',
  accepted: 'spent',
  settled: 'spent',
  disputed: 'spent',
  resolved: 'spent',
  blocked: 'released',
  cancelled: 'released',
  failed: 'released',
  refunded: 'released',
};

export function budgetEffect(status: PurchaseStatus): BudgetEffect {
  return EFFECT[status];
}

export type PeriodBounds = { start: Date; end: Date | null };

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));

/**
 * The UTC calendar period containing `now`: a day from midnight, a week from Monday, a month from
 * the first. A one-off budget runs from the mandate's confirmation to its expiry, if it has one.
 */
export function periodBounds(period: BudgetPeriod, now: Date, confirmedAt: Date, expiresAt: Date | null): PeriodBounds {
  const [year, month, day] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  switch (period) {
    case 'day':
      return { start: utc(year, month, day), end: utc(year, month, day + 1) };
    case 'week': {
      const monday = day - ((now.getUTCDay() + 6) % 7);
      return { start: utc(year, month, monday), end: utc(year, month, monday + 7) };
    }
    case 'month':
      return { start: utc(year, month, 1), end: utc(year, month + 1, 1) };
    case 'once':
      return { start: confirmedAt, end: expiresAt };
  }
}

export type BudgetPurchase = { id: string; createdAt: Date; totalCents: number | null; status: PurchaseStatus };

/** One purchase counted against the budget, with the running totals after it. */
export type BurnStep = {
  purchaseId: string;
  at: Date;
  effect: Exclude<BudgetEffect, 'released'>;
  amountCents: number;
  spentCents: number;
  inFlightCents: number;
  remainingCents: number;
};

export type BurnDown = PeriodBounds & {
  budgetCents: number;
  spentCents: number;
  inFlightCents: number;
  /** Budget minus spend and reservations: what the gate would still allow. */
  remainingCents: number;
  steps: BurnStep[];
};

/** The budget's use over the period `bounds`, from the buyer's purchases. */
export function burnDown(budgetCents: number, bounds: PeriodBounds, purchases: BudgetPurchase[]): BurnDown {
  const inPeriod = (p: BudgetPurchase) => p.createdAt >= bounds.start && (bounds.end === null || p.createdAt < bounds.end);
  const counted = purchases
    .filter((p) => p.totalCents !== null && budgetEffect(p.status) !== 'released' && inPeriod(p))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let spentCents = 0;
  let inFlightCents = 0;
  const steps = counted.map((p): BurnStep => {
    const effect = budgetEffect(p.status) as BurnStep['effect'];
    const amountCents = p.totalCents ?? 0;
    if (effect === 'spent') spentCents += amountCents;
    else inFlightCents += amountCents;
    return {
      purchaseId: p.id,
      at: p.createdAt,
      effect,
      amountCents,
      spentCents,
      inFlightCents,
      remainingCents: budgetCents - spentCents - inFlightCents,
    };
  });

  return {
    budgetCents,
    ...bounds,
    spentCents,
    inFlightCents,
    remainingCents: budgetCents - spentCents - inFlightCents,
    steps,
  };
}
