import { categoryLabel, type Category } from '@/lib/domain/categories';
import { formatUsd } from '@/lib/domain/money';
import type { BudgetPeriod, MandatePolicy } from '@/lib/domain/policy';
import { plural } from '@/lib/domain/words';

// The plain-English readback the buyer confirms. This code renders it from the policy JSON and no
// model ever writes or rewords it, so what the buyer reads is exactly what the gate enforces. It
// shows every policy field the gate reads, one sentence per line, always in the same order.

const PER_PERIOD: Record<BudgetPeriod, string> = {
  day: 'per calendar day (UTC)',
  week: 'per calendar week (Monday to Sunday, UTC)',
  month: 'per calendar month (UTC)',
  once: 'in total',
};

const categoryList = (ids: Category[]) => ids.map(categoryLabel).join(', ');

function allowedCategories({ allow, deny }: MandatePolicy['categories']): string {
  if (allow === null) return deny.length > 0 ? 'Any category not listed below.' : 'Any category.';
  if (allow.length === 0) return 'No category is allowed.';
  return `Allowed categories: ${categoryList(allow)}.`;
}

function allowedSellers({ allow, deny }: MandatePolicy['merchants']): string {
  if (allow === null) return deny.length > 0 ? 'Any seller not listed below.' : 'Any seller.';
  if (allow.length === 0) return 'No seller is allowed.';
  return `Only these sellers: ${allow.join(', ')}.`;
}

/**
 * The UTC instant the mandate ends. An expiry at the last millisecond of a UTC day reads as that
 * date alone; any other instant also shows its UTC time, so the buyer never reads a whole day the
 * gate does not allow.
 */
function endDate(expiresAt: string): string {
  const iso = new Date(expiresAt).toISOString();
  const date = iso.slice(0, 10);
  return iso.endsWith('T23:59:59.999Z') ? `Ends on ${date}.` : `Ends on ${date} at ${iso.slice(11, 16)} UTC.`;
}

/** The readback of a policy, one sentence per line. */
export function renderReadback(policy: MandatePolicy): string[] {
  const { budget, categories, merchants, velocity, expiresAt } = policy;
  return [
    `Your agent can spend up to ${formatUsd(budget.amountCents)} ${PER_PERIOD[budget.period]}.`,
    `Any single purchase over ${formatUsd(policy.perPurchaseMaxCents)} is blocked.`,
    policy.askAboveCents === null
      ? 'No purchase needs your approval because of its amount alone.'
      : `Purchases over ${formatUsd(policy.askAboveCents)} need your approval.`,
    allowedCategories(categories),
    ...(categories.deny.length > 0 ? [`Never: ${categoryList(categories.deny)}.`] : []),
    allowedSellers(merchants),
    ...(merchants.deny.length > 0 ? [`Never from: ${merchants.deny.join(', ')}.`] : []),
    velocity === null
      ? 'No limit on how often it buys.'
      : `At most ${plural(velocity.maxPurchases, 'purchase')} in any ${plural(velocity.windowHours, 'hour')}.`,
    expiresAt === null ? 'No end date.' : endDate(expiresAt),
  ];
}
