import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import { chargeAllowed } from '@/lib/purchases/charge';
import { setUp } from '@/tests/helpers/purchase-deps';

// A dispute PayPal opened against a purchase, for tests of answering it.

export const PAYPAL_DISPUTE_ID = 'PP-D-1001';

/** Records a dispute PayPal opened against the purchase, or against no purchase Behest knows, and returns its row id. */
export async function openDispute(db: Db, purchaseId: string | null): Promise<string> {
  const [row] = await db
    .insert(disputes)
    .values({
      paypalDisputeId: PAYPAL_DISPUTE_ID,
      purchaseId,
      captureId: 'CAPTURE-1',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      amountCents: 1875,
      buyerNotes: 'I never asked for this.',
    })
    .returning({ id: disputes.id });
  return row.id;
}

/** A purchase the policy allowed, charged and given its signed receipt by the real purchase flow, under dispute. */
export async function chargedDispute() {
  const s = await setUp();
  await chargeAllowed(s.deps, s.purchaseId);
  return { ...s, disputeId: await openDispute(s.db, s.purchaseId) };
}
