import { formatUsd } from '@/lib/domain/money';
import type { BudgetPeriod } from '@/lib/domain/policy';
import { plural } from '@/lib/domain/words';
import { atOrBelow, block, pass, type CartContext, type Check } from './check';

// Hard limits: breaking any of them blocks the purchase.

const HOUR_MS = 60 * 60 * 1000;

export function perPurchaseMax({ cart, policy }: CartContext): Check {
  const total = formatUsd(cart.totalCents);
  const limit = `${formatUsd(policy.perPurchaseMaxCents)} per-purchase limit`;
  return atOrBelow(cart.totalCents, policy.perPurchaseMaxCents)
    ? pass(`${total} is within your ${limit}`)
    : block(`${total} is over your ${limit}`);
}

const LEFT_IN_PERIOD: Record<BudgetPeriod, string> = {
  day: 'left this day',
  week: 'left this week',
  month: 'left this month',
  once: 'left on this mandate',
};

export function budgetRemaining({ cart, policy, input }: CartContext): Check {
  const remaining = Math.max(0, policy.budget.amountCents - input.spentInPeriodCents);
  const total = formatUsd(cart.totalCents);
  const left = `${formatUsd(remaining)} ${LEFT_IN_PERIOD[policy.budget.period]}`;
  return atOrBelow(cart.totalCents, remaining)
    ? pass(`${total} fits in the ${left}`)
    : block(`${total} would exceed the ${left}`);
}

export function velocity({ policy, input }: CartContext): Check {
  if (policy.velocity === null) return pass('Your mandate sets no limit on how often to buy');
  const { maxPurchases, windowHours } = policy.velocity;
  const windowStart = input.now.getTime() - windowHours * HOUR_MS;
  const recent = input.recentPurchaseTimes.filter((t) => t.getTime() > windowStart).length;
  const limit = `limit of ${plural(maxPurchases, 'purchase')} in ${plural(windowHours, 'hour')}`;
  return recent < maxPurchases ? pass(`Within your ${limit}`) : block(`Your ${limit} is already reached`);
}
