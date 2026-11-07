import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import type { DisputeDetail } from '@/lib/paypal/port';
import { chargeAllowed } from '@/lib/purchases/charge';
import { setUp } from '@/tests/helpers/purchase-deps';

// A dispute PayPal opened against a purchase, for tests of answering it.

export const PAYPAL_DISPUTE_ID = 'PP-D-1001';

/** The links PayPal gives an inquiry waiting for the seller, as the sandbox read one. */
export const INQUIRY_ACTIONS = ['accept_claim', 'send_message', 'escalate', 'make_offer'];

/**
 * The dispute as PayPal reads it live: by default a claim waiting for Behest, which takes evidence.
 * `changes` sets another status, stage or set of actions.
 */
export function paypalDispute(changes: Partial<DisputeDetail> = {}): DisputeDetail {
  return {
    id: PAYPAL_DISPUTE_ID,
    status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    amountCents: 1875,
    captureId: 'CAPTURE-1',
    createTime: '2026-11-06T12:30:00.000Z',
    buyerNotes: 'I never asked for this.',
    outcome: null,
    stage: 'CHARGEBACK',
    actions: ['provide_evidence', 'accept_claim'],
    ...changes,
  };
}

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

/**
 * A purchase the policy allowed, charged and given its signed receipt by the real purchase flow,
 * under dispute, with a fake PayPal that reads the dispute as a claim taking evidence.
 */
export async function chargedDispute() {
  const s = await setUp();
  await chargeAllowed(s.deps, s.purchaseId);
  s.paypal.disputes = [paypalDispute()];
  return { ...s, disputeId: await openDispute(s.db, s.purchaseId) };
}
