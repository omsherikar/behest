import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { mandates, purchases } from '@/lib/db/schema';
import { MandatePolicy } from '@/lib/domain/policy';
import { mandateActive } from '@/lib/gate/rules/mandate';

// Checking a purchase's mandate again on its way to the money. The gate checked it, but a buyer can
// revoke a mandate, by confirming a new one, at any moment until the payment is under way, and a
// mandate can expire. Each check holds the mandate's row FOR SHARE until the caller's transaction
// ends, so no confirmation can revoke it in between.

/** What blocks a purchase whose mandate cannot be read back with a valid policy. */
export const MANDATE_UNREADABLE = 'The mandate could not be checked again, so nothing was bought.';

/** The reason a charge or an approval is refused because the purchase's mandate has ended. */
export const MANDATE_NOT_ACTIVE = 'mandate no longer active';

/**
 * Why the mandate no longer authorizes purchases at `now`, in the gate's words, or null while it is
 * still active and unexpired. Locks the mandate's row FOR SHARE until the caller's transaction ends.
 */
export async function whyMandateEnded(tx: Db, mandateId: string, now: Date): Promise<string | null> {
  const [mandate] = await tx
    .select({ status: mandates.status, expiresAt: mandates.expiresAt, policy: mandates.policy })
    .from(mandates)
    .where(eq(mandates.id, mandateId))
    .for('share');
  const policy = MandatePolicy.safeParse(mandate?.policy);
  if (!mandate || !policy.success) return MANDATE_UNREADABLE;
  const check = mandateActive({ mandate: { status: mandate.status, expiresAt: mandate.expiresAt }, now }, policy.data);
  return check.result === 'pass' ? null : check.detail;
}

/** Whether the purchase's mandate still authorizes it at `now`, checked as whyMandateEnded does. */
export async function purchaseMandateActive(tx: Db, purchaseId: string, now: Date): Promise<boolean> {
  const [purchase] = await tx.select({ mandateId: purchases.mandateId }).from(purchases).where(eq(purchases.id, purchaseId));
  return purchase !== undefined && (await whyMandateEnded(tx, purchase.mandateId, now)) === null;
}
