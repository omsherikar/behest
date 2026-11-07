import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobs, mandates, purchases, receipts } from '@/lib/db/schema';
import { runDueJobs, type JobOutcome } from '@/lib/jobs/queue';
import { evaluateGate, type CatalogEntry } from '@/lib/gate/evaluate';
import { completeApproval, expireApproval, startApproval } from '@/lib/purchases/approval';
import { retryCharge, takePayment } from '@/lib/purchases/charge';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { COUNTS_AGAINST_BUDGET } from '@/lib/purchases/transitions';
import { hashOf } from '@/lib/receipts/canonical';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { jwks, NOW, PASSED, setUp } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, SEEDED_SELLER, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const HOUR_MS = 60 * 60 * 1000;
/** When the `approval_expiry` job queued with an approval first runs. */
const EXPIRES_AT = new Date(NOW.getTime() + 3 * HOUR_MS);
/** What the first failed attempt to create an approval order is logged under. */
const FIRST_ATTEMPT_FAILED = 'Creating an approval order failed, so PayPal is asked again:';
/** When the `charge_retry` job queued with an approval's capture first runs. */
const RETRY_AT = new Date(NOW.getTime() + 2 * 60 * 1000);
const APP_URL = 'https://behest.example.com';

const NO_WALLET = 'No saved PayPal wallet is linked';
/** The gate's outcomes for a purchase it sent to the buyer: every rule passed but the wallet check. */
const ASKED = PASSED.map((o) => (o.rule === 'wallet_linked' ? { ...o, result: 'ask' as const, detail: NO_WALLET } : o));

const approvalRequestId = (purchaseId: string) => `${purchaseId}:approval`;
const captureRequestId = (purchaseId: string) => `${purchaseId}:capture`;

/** The order id and request id of every capture PayPal was asked for, in order. */
function captureCalls(paypal: FakePaypal): [string, string][] {
  return paypal.callsTo('captureOrder');
}

/** The kinds of the purchase's events other than status changes, in order. */
async function stepsOf(db: PurchaseDeps['db'], purchaseId: string): Promise<string[]> {
  return (await eventsOf(db, purchaseId)).filter((e) => e.kind !== 'status').map((e) => e.kind);
}


/**
 * The gate's budget check of the buyer's next proposal, ten jars of turmeric for $45.00, with the
 * spend a proposal reserves against the $60.00 monthly budget: every purchase of the buyer in a
 * status that counts against it. All of them were made this month.
 */
async function budgetCheckOfNextProposal(db: PurchaseDeps['db'], buyerId: string) {
  const held = await db
    .select({ totalCents: purchases.totalCents })
    .from(purchases)
    .where(and(eq(purchases.buyerId, buyerId), inArray(purchases.status, [...COUNTS_AGAINST_BUDGET])));
  const turmeric: CatalogEntry = { sku: 'TUR-100', title: 'Turmeric, 100 g', category: 'spices', priceCents: 450, stock: null, flags: [], marketMedianCents: null };
  const { outcomes } = evaluateGate({
    policy: demoPolicy,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: { slug: SEEDED_SELLER.slug, name: SEEDED_SELLER.name },
    proposal: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'TUR-100', quantity: 10 }], rationale: 'More turmeric' },
    catalog: new Map([[turmeric.sku, turmeric]]),
    spentInPeriodCents: held.reduce((sum, p) => sum + (p.totalCents ?? 0), 0),
    recentPurchaseTimes: [],
    now: NOW,
  });
  return outcomes.find((o) => o.rule === 'budget_remaining');
}

/** A promise the test resolves when it chooses, to order two calls that overlap. */
function signal() {
  let fire = () => {};
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fire, fired };
}

/** When each `approval_expiry` job still queued is due, in order. */
async function expiryTimes(db: PurchaseDeps['db']): Promise<Date[]> {
  const queued = await db
    .select({ runAt: jobs.runAt })
    .from(jobs)
    .where(and(eq(jobs.kind, 'approval_expiry'), eq(jobs.status, 'queued')));
  return queued.map((j) => j.runAt).sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Overlaps a replay of the capture with the first call that PayPal tells the order is not
 * approved. The replay reaches PayPal while the purchase is still `charging`, and the buyer approves
 * the order before the replay's capture. With `captures: 'before the reopen'`, PayPal captures for
 * the replay before the first call sends the purchase back for approval, and the replay's answer
 * arrives after; with `'after the reopen'`, the replay is captured only once the purchase is back
 * awaiting approval. Resolves with the first call's outcome and the replay's.
 */
async function raceReplayWithReopen(
  s: Awaited<ReturnType<typeof setUpAwaiting>>,
  captures: 'before the reopen' | 'after the reopen',
) {
  const { deps, paypal, purchaseId, orderId } = s;
  const capture = paypal.captureOrder.bind(paypal);
  const replayAtPaypal = signal();
  const firstDone = signal();
  let replay: Promise<JobOutcome> | undefined;
  paypal.captureOrder = async (id, requestId) => {
    if (!replay) {
      // The first call: PayPal refuses, since the buyer has not approved yet.
      const refusal = await capture(id, requestId).catch((error: unknown) => error);
      if (captures === 'before the reopen') paypal.approve(id);
      replay = retryCharge(deps, purchaseId);
      await replayAtPaypal.fired;
      throw refusal;
    }
    // The replay, which found the purchase charging.
    if (captures === 'before the reopen') {
      const answer = await capture(id, requestId);
      replayAtPaypal.fire();
      await firstDone.fired;
      return answer;
    }
    replayAtPaypal.fire();
    await firstDone.fired;
    paypal.approve(id);
    return capture(id, requestId);
  };
  const first = await completeApproval(deps, orderId).finally(firstDone.fire);
  return { first, replay: await replay };
}

/**
 * Runs a replay of the capture to the end inside the first call's capture, after PayPal refused the
 * first call because the buyer had not approved yet: the buyer approves, and PayPal answers the
 * replay with `status`. The first call then acts on its refusal.
 */
async function replayInsideFirstCapture(s: Awaited<ReturnType<typeof setUpAwaiting>>, status: 'COMPLETED' | 'PENDING') {
  const { deps, paypal, purchaseId, orderId } = s;
  const capture = paypal.captureOrder.bind(paypal);
  let calls = 0;
  paypal.captureOrder = async (id, requestId) => {
    calls += 1;
    if (calls > 1) return capture(id, requestId);
    const refusal = await capture(id, requestId).catch((error: unknown) => error);
    paypal.approve(id);
    if (status === 'PENDING') paypal.failNext('captureOrder', { status: 'PENDING' });
    expect(await retryCharge(deps, purchaseId)).toBe('done');
    throw refusal;
  };
  return completeApproval(deps, orderId);
}

/** Runs the jobs due by the clock, with retryCharge and expireApproval as their handlers. */
function runJobs(deps: PurchaseDeps, clock: { now: Date }): Promise<number> {
  return runDueJobs(
    deps.db,
    {
      charge_retry: (payload, d) => retryCharge(d, String(payload.purchaseId)),
      approval_expiry: (payload, d) => expireApproval(d, String(payload.purchaseId)),
    },
    deps,
    () => clock.now,
  );
}

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

/** A purchase awaiting approval whose order the buyer has approved at PayPal, when `approve` says so. */
async function setUpAwaiting({ approve = true }: { approve?: boolean } = {}) {
  const s = await setUpAsk();
  const { approveUrl } = await startApproval(s.deps, s.purchaseId);
  const { paypalOrderId: orderId } = await purchaseRow(s.db, s.purchaseId);
  if (!orderId || !approveUrl) throw new Error('the approval was not started');
  if (approve) s.paypal.approve(orderId);
  return { ...s, orderId, approveUrl };
}

/** An approved purchase left charging by two thrown capture attempts, PayPal having captured the first when `lost` says so. */
async function setUpUnknownCapture({ lost, approve = true }: { lost: boolean; approve?: boolean }) {
  const s = await setUpAwaiting({ approve });
  const failure = lost ? 'lost_response' : 'network';
  s.paypal.failNext('captureOrder', failure);
  s.paypal.failNext('captureOrder', failure);
  await completeApproval(s.deps, s.orderId);
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
      {
        kind: 'approval_order',
        data: { requestId: approvalRequestId(purchaseId), orderId, approveUrl, expiresAt: EXPIRES_AT.toISOString() },
      },
    ]);
  });

  it('logs the first failure and asks again with the same request id when the answer is lost, creating one order', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('createApprovalOrder', 'lost_response');

    const outcome = await startApproval(deps, purchaseId);

    const requestIds = paypal.callsTo('createApprovalOrder').map(([i]) => i.requestId);
    expect(requestIds).toEqual([approvalRequestId(purchaseId), approvalRequestId(purchaseId)]);
    expect(outcome).toMatchObject({ status: 'awaiting_approval', approveUrl: expect.stringContaining('ORDER-1') });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ paypalOrderId: 'ORDER-1' });
    expect(logged.mock.calls).toEqual([[`${FIRST_ATTEMPT_FAILED} purchase ${purchaseId}: fetch failed`]]);
  });

  it('cancels the purchase, releasing its budget, when PayPal cannot create the order twice', async () => {
    const { db, deps, paypal, purchaseId } = await setUpAsk();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('createApprovalOrder', 'network');
    paypal.failNext('createApprovalOrder', 'network');

    const outcome = await startApproval(deps, purchaseId);

    // The first failure is logged, and the second is recorded on the purchase.
    expect(logged.mock.calls).toEqual([[`${FIRST_ATTEMPT_FAILED} purchase ${purchaseId}: fetch failed`]]);

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

  it.each([
    ['revoked', { status: 'revoked' as const }],
    ['expired', { status: 'expired' as const }],
    ['past its expiry', { expiresAt: new Date(NOW.getTime() - 1000) }],
  ])('fails without asking PayPal when its mandate is %s by the time it goes to the buyer', async (_, change) => {
    const s = await setUpAsk();
    await s.db.update(mandates).set(change).where(eq(mandates.id, s.mandateId));

    const outcome = await startApproval(s.deps, s.purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', approveUrl: null, receiptId: null });
    expect(s.paypal.calls).toEqual([]);
    expect(await jobKinds(s.db)).toEqual([]);
    expect(await eventsOf(s.db, s.purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      { kind: 'charge_refused', data: { reason: 'mandate no longer active' } },
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

describe('completeApproval', () => {
  it('captures the approved order, signs a receipt naming the buyer as approver and ends accepted with the seller paid', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId, approveUrl } = await setUpAwaiting();

    const outcome = await completeApproval(deps, orderId);

    const [receipt] = await db.select().from(receipts);
    expect(outcome).toEqual({ purchaseId, verdict: 'ASK', status: 'accepted', reasons: [NO_WALLET], approveUrl, receiptId: receipt.id });
    expect(captureCalls(paypal)).toEqual([[orderId, captureRequestId(purchaseId)]]);
    expect(paypal.captures).toHaveLength(1);
    const [{ captureId }] = paypal.captures;
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'accepted',
      approver: 'human',
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: NOW,
    });

    // The receipt passes every check an outside seller runs, and says the buyer approved the payment.
    const verified = await verifyReceipt({
      jws: receipt.jws,
      cart: seededCart,
      sellerSlug: SEEDED_SELLER.slug,
      jwks,
      now: NOW,
      seen: async () => false,
    });
    expect(verified).toMatchObject({
      ok: true,
      payload: {
        id: receipt.id,
        cart: { hash: hashOf(seededCart) },
        decision: { purchaseId, verdict: 'ASK', approver: 'human' },
        payment: { orderId, captureId, amountCents: seededCart.totalCents, capturedAt: NOW.toISOString() },
      },
    });
    expect(seller.orders).toEqual([{ sellerSlug: SEEDED_SELLER.slug, cart: seededCart, receiptJws: receipt.jws }]);
    expect(paypal.payouts).toHaveLength(1);
    expect(await jobKinds(db)).toEqual(['approval_expiry', 'charge_retry', 'payout_poll']);
  });

  it('logs the capture request and queues its retry before asking PayPal, then logs the capture, receipt and acceptance', async () => {
    const { db, deps, paypal, purchaseId, orderId } = await setUpAwaiting();

    const { receiptId } = await completeApproval(deps, orderId);

    const [{ captureId }] = paypal.captures;
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([
      { kind: 'status', data: { from: 'awaiting_approval', to: 'charging' } },
      { kind: 'charge', data: { orderId, requestId: captureRequestId(purchaseId), startedAt: NOW.toISOString() } },
      { kind: 'capture', data: { orderId, captureId } },
      { kind: 'status', data: { from: 'charging', to: 'captured' } },
      { kind: 'receipt', data: { receiptId } },
      { kind: 'seller_accepted', data: { receiptId } },
      { kind: 'status', data: { from: 'captured', to: 'accepted' } },
    ]);
    expect(await db.select({ payload: jobs.payload, runAt: jobs.runAt }).from(jobs).where(eq(jobs.kind, 'charge_retry'))).toEqual([
      { payload: { purchaseId }, runAt: RETRY_AT },
    ]);
  });

  it('returns where the purchase stands, calling nothing, when the webhook completes an approval the return already completed', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting();
    const fromReturn = await completeApproval(deps, orderId);
    const callsBefore = paypal.calls.length;

    const fromWebhook = await completeApproval(deps, orderId);

    expect(fromWebhook).toEqual(fromReturn);
    expect(paypal.calls).toHaveLength(callsBefore);
    expect(paypal.captures).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'capture', 'receipt', 'seller_accepted']);
  });

  it('captures, receipts, delivers and pays once when the return and the webhook arrive together', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting();

    await Promise.all([completeApproval(deps, orderId), completeApproval(deps, orderId)]);

    expect(captureCalls(paypal)).toHaveLength(1);
    expect(paypal.captures).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await jobKinds(db)).toEqual(['approval_expiry', 'charge_retry', 'payout_poll']);
  });

  it('sends the purchase back for approval, its link kept, when the buyer has not approved the order', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId, approveUrl } = await setUpAwaiting({ approve: false });

    const outcome = await completeApproval(deps, orderId);

    expect(outcome).toMatchObject({ status: 'awaiting_approval', approveUrl, receiptId: null });
    // PayPal's refusal is final, so it is not asked again.
    expect(captureCalls(paypal)).toEqual([[orderId, captureRequestId(purchaseId)]]);
    expect(paypal.captures).toEqual([]);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'awaiting_approval',
      approver: null,
      paypalOrderId: orderId,
      paypalCaptureId: null,
      approveUrl,
    });
    expect(seller.orders).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(3)).toEqual([
      expect.objectContaining({ kind: 'charge' }),
      { kind: 'approval_pending', data: { orderId, requestId: captureRequestId(purchaseId) } },
      { kind: 'status', data: { from: 'charging', to: 'awaiting_approval' } },
    ]);
    // A fresh expiry, still due when the approval window first opened ends.
    expect(await expiryTimes(db)).toEqual([EXPIRES_AT, EXPIRES_AT]);

    // The buyer approves after all, and the next return captures the order.
    paypal.approve(orderId);
    expect(await completeApproval(deps, orderId)).toMatchObject({ status: 'accepted', approveUrl });
    expect(paypal.captures).toHaveLength(1);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ approver: 'human' });
  });

  it('asks again with the same request id when the answer is lost after PayPal captured, capturing once', async () => {
    const { db, deps, paypal, purchaseId, orderId } = await setUpAwaiting();
    paypal.failNext('captureOrder', 'lost_response');

    const outcome = await completeApproval(deps, orderId);

    expect(captureCalls(paypal)).toEqual([
      [orderId, captureRequestId(purchaseId)],
      [orderId, captureRequestId(purchaseId)],
    ]);
    expect(paypal.captures).toHaveLength(1);
    expect(outcome.status).toBe('accepted');
    expect(await db.select().from(receipts)).toHaveLength(1);
  });

  it('ends failed with no receipt, releasing the budget, when PayPal declines the capture', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting();
    paypal.failNext('captureOrder', { status: 'DECLINED' });

    const outcome = await completeApproval(deps, orderId);

    expect(outcome).toMatchObject({ status: 'failed', receiptId: null });
    expect(paypal.captures).toEqual([]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(4)).toEqual([
      { kind: 'charge_declined', data: { requestId: captureRequestId(purchaseId) } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('keeps a pending capture charging with its PayPal ids, issuing no receipt and calling no seller', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting();
    paypal.failNext('captureOrder', { status: 'PENDING' });

    const outcome = await completeApproval(deps, orderId);

    const [{ captureId }] = paypal.captures;
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'charging', paypalOrderId: orderId, paypalCaptureId: captureId });
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'capture_pending']);
  });

  it('leaves the purchase charging, its budget reserved and its retry queued, when PayPal fails twice', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting();
    paypal.failNext('captureOrder', 'network');
    paypal.failNext('captureOrder', 'network');

    const outcome = await completeApproval(deps, orderId);

    expect(captureCalls(paypal)).toHaveLength(2);
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await jobKinds(db)).toEqual(['approval_expiry', 'charge_retry']);
    expect(seller.orders).toEqual([]);
    expect((await eventsOf(db, purchaseId)).at(-1)).toEqual({
      kind: 'charge_unknown',
      data: { requestId: captureRequestId(purchaseId), error: 'fetch failed', errorClass: 'TypeError' },
    });
  });

  it('throws for an order no purchase was sent to PayPal with', async () => {
    const { deps, paypal } = await setUpAwaiting();

    await expect(completeApproval(deps, 'ORDER-9')).rejects.toThrow('there is no purchase with PayPal order ORDER-9');

    expect(captureCalls(paypal)).toEqual([]);
  });
});

describe('retrying the capture of an approved order', () => {
  it('runs from its job, replays exactly the capture request and ends accepted with one capture', async () => {
    const { db, deps, paypal, clock, purchaseId, orderId } = await setUpUnknownCapture({ lost: true });
    clock.now = RETRY_AT;

    expect(await runJobs(deps, clock)).toBe(1);

    expect(captureCalls(paypal)).toEqual(Array(3).fill([orderId, captureRequestId(purchaseId)]));
    expect(paypal.captures).toHaveLength(1);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'accepted', approver: 'human' });
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'charge_unknown', 'capture', 'receipt', 'seller_accepted']);
  });

  it('captures once when PayPal never received the first two attempts', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCapture({ lost: false });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('sends the purchase back for approval when the replay finds the order unapproved', async () => {
    const { db, deps, paypal, purchaseId, orderId, approveUrl } = await setUpUnknownCapture({ lost: false, approve: false });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(captureCalls(paypal)).toHaveLength(3);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'awaiting_approval', approveUrl, paypalOrderId: orderId });
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'charge_unknown', 'approval_pending']);
  });

  it('does nothing for a purchase already sent back for approval', async () => {
    const { deps, paypal, purchaseId, orderId } = await setUpAwaiting({ approve: false });
    await completeApproval(deps, orderId);

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(captureCalls(paypal)).toHaveLength(1);
  });

  it.each(['before the reopen', 'after the reopen'] as const)(
    'records a capture PayPal makes for a replay %s, delivering and paying once',
    async (captures) => {
      const s = await setUpAwaiting({ approve: false });
      const { db, paypal, seller, purchaseId } = s;

      const { first, replay } = await raceReplayWithReopen(s, captures);

      expect(first).toMatchObject({ status: 'awaiting_approval' });
      expect(replay).toBe('done');
      expect(paypal.captures).toHaveLength(1);
      const [{ captureId }] = paypal.captures;
      expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'accepted', approver: 'human', paypalCaptureId: captureId });
      expect(await db.select().from(receipts)).toHaveLength(1);
      expect(seller.orders).toHaveLength(1);
      expect(paypal.payouts).toHaveLength(1);
      expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'approval_pending', 'capture', 'receipt', 'seller_accepted']);
      expect((await eventsOf(db, purchaseId)).filter((e) => e.kind === 'status').map((e) => e.data)).toEqual([
        { from: 'proposed', to: 'awaiting_approval' },
        { from: 'awaiting_approval', to: 'charging' },
        { from: 'charging', to: 'awaiting_approval' },
        { from: 'awaiting_approval', to: 'charging' },
        { from: 'charging', to: 'captured' },
        { from: 'captured', to: 'accepted' },
      ]);
    },
  );

  it('does not send the purchase back for approval once a replay has completed its capture', async () => {
    const s = await setUpAwaiting({ approve: false });

    const outcome = await replayInsideFirstCapture(s, 'COMPLETED');

    expect(outcome).toMatchObject({ status: 'accepted' });
    expect(s.paypal.captures).toHaveLength(1);
    expect(await s.db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(s.db, s.purchaseId)).not.toContain('approval_pending');
  });

  it('does not send the purchase back for approval once a replay has stored a pending capture', async () => {
    const s = await setUpAwaiting({ approve: false });

    const outcome = await replayInsideFirstCapture(s, 'PENDING');

    const [{ captureId }] = s.paypal.captures;
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await purchaseRow(s.db, s.purchaseId)).toMatchObject({ status: 'charging', paypalCaptureId: captureId });
    expect(await stepsOf(s.db, s.purchaseId)).toEqual(['approval_order', 'charge', 'capture_pending']);
  });

  it('stores a pending capture PayPal reports for a replay after the purchase went back for approval', async () => {
    const s = await setUpAwaiting({ approve: false });
    const { db, paypal, purchaseId, clock } = s;
    const capture = paypal.captureOrder.bind(paypal);
    let calls = 0;
    paypal.captureOrder = async (id, requestId) => {
      calls += 1;
      if (calls === 2) paypal.failNext('captureOrder', { status: 'PENDING' });
      return capture(id, requestId);
    };
    const { first } = await raceReplayWithReopen(s, 'after the reopen');
    clock.now = EXPIRES_AT;

    expect(first).toMatchObject({ status: 'awaiting_approval' });
    const [{ captureId }] = paypal.captures;
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'charging', approver: 'human', paypalCaptureId: captureId });
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'charge', 'approval_pending', 'capture_pending']);
    // The queued replay and both expiries leave it to the webhook that reports the capture.
    expect(await runJobs(s.deps, clock)).toBe(3);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('refuses to replay a capture older than the replay window', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCapture({ lost: false });
    clock.now = new Date(NOW.getTime() + 5 * HOUR_MS + 1);

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('too old to replay');

    expect(captureCalls(paypal)).toHaveLength(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });
});

describe('expireApproval', () => {
  it('cancels a purchase left unapproved for three hours from its job, releasing its budget for the next proposal', async () => {
    const { db, deps, clock, paypal, buyerId, purchaseId } = await setUpAwaiting({ approve: false });
    expect(await budgetCheckOfNextProposal(db, buyerId)).toMatchObject({ result: 'block' });
    clock.now = new Date(EXPIRES_AT.getTime() - 1);
    expect(await runJobs(deps, clock)).toBe(0);
    clock.now = EXPIRES_AT;

    expect(await runJobs(deps, clock)).toBe(1);

    expect(await db.select({ status: jobs.status }).from(jobs).where(eq(jobs.kind, 'approval_expiry'))).toEqual([{ status: 'done' }]);
    expect(await statusOf(db, purchaseId)).toBe('cancelled');
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([
      { kind: 'approval_expired', data: {} },
      { kind: 'status', data: { from: 'awaiting_approval', to: 'cancelled' } },
    ]);
    expect(captureCalls(paypal)).toEqual([]);
    expect(await budgetCheckOfNextProposal(db, buyerId)).toMatchObject({ result: 'pass' });
  });

  it('does nothing once the buyer has approved and the order is captured', async () => {
    const { db, deps, purchaseId, orderId } = await setUpAwaiting();
    await completeApproval(deps, orderId);
    const before = await eventsOf(db, purchaseId);

    expect(await expireApproval(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await eventsOf(db, purchaseId)).toEqual(before);
  });

  it('never captures a purchase it cancelled, even if the buyer approves the order later', async () => {
    const { db, deps, paypal, seller, purchaseId, orderId } = await setUpAwaiting({ approve: false });
    await expireApproval(deps, purchaseId);
    paypal.approve(orderId);

    const outcome = await completeApproval(deps, orderId);

    expect(outcome).toMatchObject({ status: 'cancelled', receiptId: null });
    expect(captureCalls(paypal)).toEqual([]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect(await stepsOf(db, purchaseId)).toEqual(['approval_order', 'approval_expired']);
  });

  it('lets only one of an expiry and an approval called at once move the purchase', async () => {
    const { db, deps, paypal, purchaseId, orderId } = await setUpAwaiting();

    await Promise.all([expireApproval(deps, purchaseId), completeApproval(deps, orderId)]);

    const steps = await stepsOf(db, purchaseId);
    const winners = steps.filter((kind) => kind === 'approval_expired' || kind === 'charge');
    expect(winners).toHaveLength(1);
    const [winner] = winners;
    const ended = {
      status: await statusOf(db, purchaseId),
      captureCalls: captureCalls(paypal).length,
      captures: paypal.captures.length,
      receipts: (await db.select().from(receipts)).length,
    };
    expect(ended).toEqual(
      winner === 'approval_expired'
        ? { status: 'cancelled', captureCalls: 0, captures: 0, receipts: 0 }
        : { status: 'accepted', captureCalls: 1, captures: 1, receipts: 1 },
    );
  });

  it('leaves a purchase alone while its approval is being captured, so the approval completes', async () => {
    const { db, deps, paypal, purchaseId, orderId } = await setUpAwaiting();
    const capture = paypal.captureOrder.bind(paypal);
    const expiries: string[] = [];
    paypal.captureOrder = async (id, requestId) => {
      expiries.push(await expireApproval(deps, purchaseId));
      return capture(id, requestId);
    };

    const outcome = await completeApproval(deps, orderId);

    expect(expiries).toEqual(['done']);
    expect(outcome.status).toBe('accepted');
    expect(paypal.captures).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).not.toContain('approval_expired');
    expect(await expireApproval(deps, purchaseId)).toBe('done');
  });

  it('cancels a purchase PayPal sends back for approval after its deadline, from the expiry queued then', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCapture({ lost: false, approve: false });
    // PayPal is still unreachable once the deadline has passed: the replay is put off, and the
    // expiry finds the purchase charging and leaves it.
    clock.now = new Date(EXPIRES_AT.getTime() + 60_000);
    paypal.failNext('captureOrder', 'network');
    paypal.failNext('captureOrder', 'network');
    expect(await runJobs(deps, clock)).toBe(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');

    // The next replay reaches PayPal, which says the buyer never approved.
    clock.now = new Date(clock.now.getTime() + 15_000);
    expect(await runJobs(deps, clock)).toBe(1);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
    expect(await expiryTimes(db)).toEqual([clock.now]);

    expect(await runJobs(deps, clock)).toBe(1);

    expect(await statusOf(db, purchaseId)).toBe('cancelled');
    expect(await jobKinds(db)).toEqual(['approval_expiry', 'approval_expiry', 'charge_retry']);
  });

  it('leaves a purchase whose capture is pending to the webhook that reports it', async () => {
    const { db, deps, paypal, purchaseId, orderId } = await setUpAwaiting();
    paypal.failNext('captureOrder', { status: 'PENDING' });
    await completeApproval(deps, orderId);

    expect(await expireApproval(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('throws for a purchase that does not exist', async () => {
    const { deps } = await setUpAwaiting();

    await expect(expireApproval(deps, crypto.randomUUID())).rejects.toThrow('there is no purchase');
  });
});

describe('a capture reported for an approval it does not fit', () => {
  /** Another order at PayPal, approved by its buyer, that is not the purchase's. */
  async function otherOrder(paypal: FakePaypal): Promise<string> {
    const { orderId } = await paypal.createApprovalOrder({
      amountCents: 999,
      description: 'Another order',
      invoiceId: 'another-purchase',
      returnUrl: `${APP_URL}/api/purchases/return`,
      cancelUrl: `${APP_URL}/buyer/approvals`,
      requestId: 'another-purchase:approval',
    });
    paypal.approve(orderId);
    return orderId;
  }

  /** A purchase PayPal sent back for approval and its expiry then cancelled; the buyer approves its order only afterwards. */
  async function setUpCancelledAfterReopen() {
    const s = await setUpAwaiting({ approve: false });
    await completeApproval(s.deps, s.orderId);
    await expireApproval(s.deps, s.purchaseId);
    s.paypal.approve(s.orderId);
    return s;
  }

  it('logs a pending capture of another order on a purchase charging its own, recording nothing', async () => {
    const s = await setUpAwaiting({ approve: false });
    await s.db.update(purchases).set({ status: 'charging' }).where(eq(purchases.id, s.purchaseId));
    const other = await otherOrder(s.paypal);
    s.paypal.failNext('captureOrder', { status: 'PENDING' });
    const before = await purchaseRow(s.db, s.purchaseId);

    await takePayment(s.deps, s.purchaseId, { orderId: other, requestId: 'another-purchase:capture' });

    const [{ captureId }] = s.paypal.captures;
    expect(await purchaseRow(s.db, s.purchaseId)).toEqual(before);
    expect((await eventsOf(s.db, s.purchaseId)).at(-1)).toEqual({ kind: 'capture_unmatched', data: { captureId } });
  });

  it.each(['COMPLETED', 'PENDING'] as const)(
    'logs a %s capture of another order on a purchase awaiting approval, recording nothing',
    async (status) => {
      const s = await setUpAwaiting({ approve: false });
      const other = await otherOrder(s.paypal);
      if (status === 'PENDING') s.paypal.failNext('captureOrder', { status });
      const before = await purchaseRow(s.db, s.purchaseId);

      const outcome = await takePayment(s.deps, s.purchaseId, { orderId: other, requestId: 'another-purchase:capture' });

      const [{ captureId }] = s.paypal.captures;
      expect(outcome).toMatchObject({ status: 'awaiting_approval', receiptId: null });
      expect(await purchaseRow(s.db, s.purchaseId)).toEqual(before);
      expect((await eventsOf(s.db, s.purchaseId)).at(-1)).toEqual({ kind: 'capture_unmatched', data: { captureId } });
      expect(await s.db.select().from(receipts)).toEqual([]);
    },
  );

  it.each(['COMPLETED', 'PENDING'] as const)(
    'logs a %s capture of its own order on a purchase cancelled after going back for approval, recording nothing',
    async (status) => {
      const s = await setUpCancelledAfterReopen();
      if (status === 'PENDING') s.paypal.failNext('captureOrder', { status });
      const before = await purchaseRow(s.db, s.purchaseId);

      const outcome = await takePayment(s.deps, s.purchaseId, { orderId: s.orderId, requestId: captureRequestId(s.purchaseId) });

      const [{ captureId, orderId }] = s.paypal.captures;
      expect(orderId).toBe(s.orderId);
      expect(outcome).toMatchObject({ status: 'cancelled', receiptId: null });
      expect(await purchaseRow(s.db, s.purchaseId)).toEqual(before);
      expect((await eventsOf(s.db, s.purchaseId)).at(-1)).toEqual({ kind: 'capture_unmatched', data: { captureId } });
      expect(await s.db.select().from(receipts)).toEqual([]);
      expect(s.seller.orders).toEqual([]);
    },
  );

  it('ignores a repeat of a pending capture already stored', async () => {
    const s = await setUpAwaiting();
    s.paypal.failNext('captureOrder', { status: 'PENDING' });
    await completeApproval(s.deps, s.orderId);
    const events = await eventsOf(s.db, s.purchaseId);
    const row = await purchaseRow(s.db, s.purchaseId);

    const outcome = await takePayment(s.deps, s.purchaseId, { orderId: s.orderId, requestId: captureRequestId(s.purchaseId) });

    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(s.paypal.captures).toHaveLength(1);
    expect(await purchaseRow(s.db, s.purchaseId)).toEqual(row);
    expect(await eventsOf(s.db, s.purchaseId)).toEqual(events);
  });
});
