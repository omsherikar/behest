import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { jobs, mandates, purchases } from '@/lib/db/schema';
import { startApproval } from '@/lib/purchases/approval';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { NOW, PASSED, setUp } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const HOUR_MS = 60 * 60 * 1000;
/** When the `approval_expiry` job queued with an approval first runs. */
const EXPIRES_AT = new Date(NOW.getTime() + 3 * HOUR_MS);
const APP_URL = 'https://behest.example.com';

const NO_WALLET = 'No saved PayPal wallet is linked';
/** The gate's outcomes for a purchase it sent to the buyer: every rule passed but the wallet check. */
const ASKED = PASSED.map((o) => (o.rule === 'wallet_linked' ? { ...o, result: 'ask' as const, detail: NO_WALLET } : o));

const approvalRequestId = (purchaseId: string) => `${purchaseId}:approval`;

/** The kinds of the queued and finished jobs, sorted. */
async function jobKinds(db: PurchaseDeps['db']): Promise<string[]> {
  return (await db.select({ kind: jobs.kind }).from(jobs)).map((j) => j.kind).sort();
}

/** A purchase the gate sent to its buyer because they have no saved wallet, ready for approval. */
async function setUpAsk() {
  const s = await setUp('proposed', { wallet: null });
  await s.db
    .update(purchases)
    .set({ gateVerdict: 'ASK', finalVerdict: 'ASK', approver: null, gateOutcomes: ASKED })
    .where(eq(purchases.id, s.purchaseId));
  return s;
}

describe('startApproval', () => {
  it('creates the order the buyer approves at PayPal and ends awaiting approval with its link', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();

    const outcome = await startApproval(deps, purchaseId);

    const orderId = 'ORDER-1';
    const approveUrl = `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`;
    expect(outcome).toEqual({ purchaseId, verdict: 'ASK', status: 'awaiting_approval', reasons: [NO_WALLET], approveUrl, receiptId: null });
    expect(paypal.calls).toEqual([
      {
        method: 'createApprovalOrder',
        args: [
          {
            amountCents: seededCart.totalCents,
            description: `Behest order ${purchaseId}`,
            invoiceId: purchaseId,
            returnUrl: `${APP_URL}/api/purchases/return`,
            cancelUrl: `${APP_URL}/buyer/approvals?cancelled=${purchaseId}`,
            requestId: approvalRequestId(purchaseId),
          },
        ],
      },
    ]);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'awaiting_approval',
      approver: null,
      paypalOrderId: orderId,
      paypalCaptureId: null,
      approveUrl,
    });
    expect(paypal.captures).toEqual([]);
    expect(await db.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs)).toEqual([
      { kind: 'approval_expiry', payload: { purchaseId }, runAt: EXPIRES_AT },
    ]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'awaiting_approval' } },
      { kind: 'approval_order', data: { requestId: approvalRequestId(purchaseId), orderId, approveUrl } },
    ]);
  });

  it('asks again with the same request id when the answer is lost, creating one order', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();
    paypal.failNext('createApprovalOrder', 'lost_response');

    const outcome = await startApproval(deps, purchaseId);

    const requestIds = paypal.callsTo('createApprovalOrder').map(([i]) => i.requestId);
    expect(requestIds).toEqual([approvalRequestId(purchaseId), approvalRequestId(purchaseId)]);
    expect(outcome).toMatchObject({ status: 'awaiting_approval', approveUrl: expect.stringContaining('ORDER-1') });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ paypalOrderId: 'ORDER-1' });
  });

  it('cancels the purchase, releasing its budget, when PayPal cannot create the order twice', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();
    paypal.failNext('createApprovalOrder', 'network');
    paypal.failNext('createApprovalOrder', 'network');

    const outcome = await startApproval(deps, purchaseId);

    expect(outcome).toMatchObject({ status: 'cancelled', approveUrl: null, receiptId: null });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'cancelled', paypalOrderId: null, approveUrl: null });
    expect((await eventsOf(db, purchaseId)).slice(1)).toEqual([
      {
        kind: 'approval_order_failed',
        data: { requestId: approvalRequestId(purchaseId), error: 'fetch failed', errorClass: 'TypeError' },
      },
      { kind: 'status', data: { from: 'awaiting_approval', to: 'cancelled' } },
    ]);
  });

  it.each([
    [
      'no gate outcomes',
      (db: PurchaseDeps['db'], { purchaseId }: { purchaseId: string; mandateId: string }) =>
        db.update(purchases).set({ gateOutcomes: [] }).where(eq(purchases.id, purchaseId)),
      'The purchase has no gate outcomes to put on its receipt.',
    ],
    [
      'an unsigned mandate',
      (db: PurchaseDeps['db'], { mandateId }: { purchaseId: string; mandateId: string }) =>
        db.update(mandates).set({ jws: '' }).where(eq(mandates.id, mandateId)),
      "The purchase's mandate has no signature to cite on its receipt.",
    ],
  ])('fails without asking PayPal when its receipt would have %s', async (_, breakReceipt, reason) => {
    const s = await setUpAsk();
    await breakReceipt(s.db, s);

    const outcome = await startApproval(s.deps, s.purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', approveUrl: null, receiptId: null });
    expect(s.paypal.calls).toEqual([]);
    expect(await jobKinds(s.db)).toEqual([]);
    expect(await eventsOf(s.db, s.purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      { kind: 'charge_refused', data: { reason } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('refuses a purchase that was not sent to its buyer, changing nothing', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();
    await db.update(purchases).set({ finalVerdict: 'ALLOW' }).where(eq(purchases.id, purchaseId));

    await expect(startApproval(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} has the final verdict ALLOW`);

    expect(paypal.calls).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('proposed');
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('creates one order and queues one expiry when two calls overlap', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();

    const outcomes = await Promise.all([startApproval(deps, purchaseId), startApproval(deps, purchaseId)]);

    expect(outcomes.map((o) => o.status)).toEqual(['awaiting_approval', 'awaiting_approval']);
    expect(paypal.callsTo('createApprovalOrder')).toHaveLength(1);
    expect(await jobKinds(db)).toEqual(['approval_expiry']);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it('returns where the purchase stands, creating nothing more, when called again', async () => {
    const { deps, paypal, purchaseId } = await setUpAsk();
    const first = await startApproval(deps, purchaseId);

    const second = await startApproval(deps, purchaseId);

    expect(second).toEqual(first);
    expect(paypal.callsTo('createApprovalOrder')).toHaveLength(1);
  });
});
