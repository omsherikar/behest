import { and, eq, gte, inArray, sum } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { mandates, purchases } from '@/lib/db/schema';
import { type BudgetPeriod, MandatePolicy } from '@/lib/domain/policy';
import { periodStart } from '@/lib/gate/period';
import { COUNTS_AGAINST_BUDGET } from '@/lib/purchases/transitions';

// The buyer's mandate in force, as the shop page shows it beside the agent: what the buyer
// confirmed, how much of the budget is left this period, when the agent must ask, and when the
// mandate ends. Spend is counted as the gate counts it, purchases still in flight included.

export type MandateInForce = {
  id: string;
  readback: string[];
  policyHash: string;
  confirmedAt: string;
  confirmation: 'session' | 'passkey';
  budgetCents: number;
  period: BudgetPeriod;
  spentCents: number;
  /** Never below zero. */
  leftCents: number;
  perPurchaseMaxCents: number;
  /** Null when the agent never asks on amount alone. */
  askAboveCents: number | null;
  /** The earlier of the mandate's and its policy's expiry, as an ISO timestamp, or null. */
  expiresAt: string | null;
};

/** The buyer's active mandate as of `now`, or null when they have none or it cannot be read. */
export async function mandateInForce(db: Db, buyerId: string, now: Date): Promise<MandateInForce | null> {
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.buyerId, buyerId), eq(mandates.status, 'active')));
  if (!mandate) return null;
  const parsed = MandatePolicy.safeParse(mandate.policy);
  if (!parsed.success) return null;
  const policy = parsed.data;

  const start = periodStart(policy.budget.period, now, mandate.confirmedAt);
  const [{ spent }] = await db
    .select({ spent: sum(purchases.totalCents) })
    .from(purchases)
    .where(
      and(eq(purchases.buyerId, buyerId), inArray(purchases.status, [...COUNTS_AGAINST_BUDGET]), gte(purchases.createdAt, start)),
    );
  const spentCents = Number(spent ?? 0);

  const expiries = [mandate.expiresAt, policy.expiresAt === null ? null : new Date(policy.expiresAt)].filter(
    (at): at is Date => at !== null,
  );
  const expiresAt = expiries.length === 0 ? null : new Date(Math.min(...expiries.map((at) => at.getTime()))).toISOString();

  return {
    id: mandate.id,
    readback: mandate.readback,
    policyHash: mandate.policyHash,
    confirmedAt: mandate.confirmedAt.toISOString(),
    confirmation: mandate.confirmation,
    budgetCents: policy.budget.amountCents,
    period: policy.budget.period,
    spentCents,
    leftCents: Math.max(0, policy.budget.amountCents - spentCents),
    perPurchaseMaxCents: policy.perPurchaseMaxCents,
    askAboveCents: policy.askAboveCents,
    expiresAt,
  };
}
