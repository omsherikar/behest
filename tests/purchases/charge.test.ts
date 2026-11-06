import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { jobs, purchases, receipts, wallets } from '@/lib/db/schema';
import { runDueJobs } from '@/lib/jobs/queue';
import { chargeAllowed, completeCapture, retryCharge } from '@/lib/purchases/charge';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { hashOf } from '@/lib/receipts/canonical';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { jwks, NOW, setUp } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, SEEDED_SELLER, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const HOUR_MS = 60 * 60 * 1000;
/** When the `charge_retry` job queued with a charge first runs. */
const RETRY_AT = new Date(NOW.getTime() + 2 * 60 * 1000);

const chargeRequestId = (purchaseId: string) => `${purchaseId}:charge`;

/** The request id of every charge PayPal was asked for, in order. */
function chargeRequestIds(paypal: FakePaypal): string[] {
  return paypal.callsTo('chargeSavedWallet').map(([request]) => request.requestId);
}

/** The kinds of the queued and finished jobs, sorted. */
async function jobKinds(db: PurchaseDeps['db']): Promise<string[]> {
  return (await db.select({ kind: jobs.kind }).from(jobs)).map((j) => j.kind).sort();
}

/** Runs the jobs due by the clock, with retryCharge as the `charge_retry` handler. */
function runRetryJobs(deps: PurchaseDeps, clock: { now: Date }): Promise<number> {
  return runDueJobs(deps.db, { charge_retry: (payload, d) => retryCharge(d, String(payload.purchaseId)) }, deps, () => clock.now);
}

/** The kinds of the purchase's events other than status changes, in order. */
async function stepsOf(db: PurchaseDeps['db'], purchaseId: string): Promise<string[]> {
  return (await eventsOf(db, purchaseId)).filter((e) => e.kind !== 'status').map((e) => e.kind);
}

/** A purchase left charging by two thrown charge attempts, with PayPal having captured the first when `lost` says so. */
async function setUpUnknownCharge({ lost }: { lost: boolean }) {
  const s = await setUp();
  const failure = lost ? 'lost_response' : 'network';
  s.paypal.failNext('chargeSavedWallet', failure);
  s.paypal.failNext('chargeSavedWallet', failure);
  await chargeAllowed(s.deps, s.purchaseId);
  return s;
}

describe('chargeAllowed', () => {
  it('charges the saved wallet, signs a receipt and ends accepted with the seller paid', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();

    const outcome = await chargeAllowed(deps, purchaseId);

    const [receipt] = await db.select().from(receipts);
    expect(outcome).toEqual({ purchaseId, verdict: 'ALLOW', status: 'accepted', reasons: [], approveUrl: null, receiptId: receipt.id });
    expect(paypal.callsTo('chargeSavedWallet')).toEqual([
      [
        {
          paymentTokenId: 'TOKEN-1',
          amountCents: seededCart.totalCents,
          description: `Behest order ${purchaseId}`,
          invoiceId: purchaseId,
          requestId: chargeRequestId(purchaseId),
        },
      ],
    ]);
    expect(paypal.captures).toHaveLength(1);
    const [{ orderId, captureId }] = paypal.captures;
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'accepted',
      approver: 'policy',
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: NOW,
    });

    // The receipt passes every check an outside seller runs, against the cart the seller received.
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
        payment: { orderId, captureId, amountCents: seededCart.totalCents, capturedAt: NOW.toISOString() },
      },
    });
    expect(seller.orders).toEqual([{ sellerSlug: SEEDED_SELLER.slug, cart: seededCart, receiptJws: receipt.jws }]);
    expect(paypal.payouts).toHaveLength(1);
    // The retry queued with the charge, which will find the purchase moved on, and the payout's poll.
    expect(await jobKinds(db)).toEqual(['charge_retry', 'payout_poll']);
  });

  it('logs the charge, capture, receipt and seller acceptance in order, each before the status it causes', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();

    const { receiptId } = await chargeAllowed(deps, purchaseId);

    const [{ orderId, captureId }] = paypal.captures;
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      {
        kind: 'charge',
        data: { requestId: chargeRequestId(purchaseId), amountCents: seededCart.totalCents, startedAt: NOW.toISOString() },
      },
      { kind: 'capture', data: { orderId, captureId } },
      { kind: 'status', data: { from: 'charging', to: 'captured' } },
      { kind: 'receipt', data: { receiptId } },
      { kind: 'seller_accepted', data: { receiptId } },
      { kind: 'status', data: { from: 'captured', to: 'accepted' } },
    ]);
  });

  it('asks again with the same request id when the answer is lost after PayPal captured, capturing once', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', 'lost_response');

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(chargeRequestIds(paypal)).toEqual([chargeRequestId(purchaseId), chargeRequestId(purchaseId)]);
    expect(paypal.captures).toHaveLength(1);
    expect(outcome.status).toBe('accepted');
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
  });

  it('ends failed with no receipt when PayPal declines the charge', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', receiptId: null });
    expect(await statusOf(db, purchaseId)).toBe('failed');
    expect(paypal.captures).toEqual([]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect(await jobKinds(db)).toEqual(['charge_retry']);
    expect((await eventsOf(db, purchaseId)).slice(1)).toEqual([
      expect.objectContaining({ kind: 'charge' }),
      { kind: 'charge_declined', data: { requestId: chargeRequestId(purchaseId) } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('leaves the purchase charging, its budget reserved, with one charge_retry job queued when PayPal fails twice', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', 'network');
    paypal.failNext('chargeSavedWallet', 'network');

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(chargeRequestIds(paypal)).toEqual([chargeRequestId(purchaseId), chargeRequestId(purchaseId)]);
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await statusOf(db, purchaseId)).toBe('charging');
    expect(await db.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs)).toEqual([
      { kind: 'charge_retry', payload: { purchaseId }, runAt: RETRY_AT },
    ]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([
      { kind: 'charge_unknown', data: { requestId: chargeRequestId(purchaseId), error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('keeps a pending capture charging with its PayPal ids, issuing no receipt and calling no seller', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });

    const outcome = await chargeAllowed(deps, purchaseId);

    const [{ orderId, captureId }] = paypal.captures;
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'charging',
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: null,
    });
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    // Only PayPal's webhook can say when the capture completes. The retry queued with the charge
    // finds the capture stored and stops.
    expect(await jobKinds(db)).toEqual(['charge_retry']);
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([{ kind: 'capture_pending', data: { orderId, captureId } }]);
  });

  it.each([
    ['no wallet', null],
    ['a wallet still being linked', 'pending'],
    ['a revoked wallet', 'revoked'],
  ] as const)('fails without asking PayPal when the buyer has %s', async (_, wallet) => {
    const { db, deps, paypal, purchaseId } = await setUp('proposed', { wallet });

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', receiptId: null });
    expect(paypal.calls).toEqual([]);
    expect(await jobKinds(db)).toEqual([]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      { kind: 'charge_failed', data: { reason: 'The buyer has no linked PayPal wallet.' } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('refuses a purchase that was not allowed, changing nothing', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    await db.update(purchases).set({ finalVerdict: 'ASK' }).where(eq(purchases.id, purchaseId));

    await expect(chargeAllowed(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} has the final verdict ASK`);

    expect(paypal.calls).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('proposed');
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('returns where the purchase stands, charging nothing more, when called again', async () => {
    const { deps, paypal, seller, purchaseId } = await setUp();
    const first = await chargeAllowed(deps, purchaseId);

    const second = await chargeAllowed(deps, purchaseId);

    expect(second).toEqual(first);
    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
  });
});

describe('retryCharge', () => {
  it('runs from its job, replays the same request id and ends accepted with exactly one capture', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCharge({ lost: true });
    clock.now = RETRY_AT;

    expect(await runRetryJobs(deps, clock)).toBe(1);

    expect(await db.select({ kind: jobs.kind, status: jobs.status }).from(jobs).where(eq(jobs.kind, 'charge_retry'))).toEqual([
      { kind: 'charge_retry', status: 'done' },
    ]);
    expect(chargeRequestIds(paypal)).toEqual(Array(3).fill(chargeRequestId(purchaseId)));
    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'charge_unknown', 'capture', 'receipt', 'seller_accepted']);
  });

  it('recovers a completed charge whose capture the database failed to record, through the job queued with it', async () => {
    const { db, deps, paypal, seller, clock, purchaseId } = await setUp();
    // The database refuses to record the capture, as if it went away just after PayPal answered.
    await db.execute(sql`
      create function refuse_capture() returns trigger language plpgsql as $$
      begin raise exception 'the database went away'; end $$`);
    await db.execute(sql`
      create trigger refuse_capture before update on purchases
      for each row when (new.status = 'captured') execute function refuse_capture()`);

    await expect(chargeAllowed(deps, purchaseId)).rejects.toThrow();

    expect(paypal.captures).toHaveLength(1);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'charging', paypalCaptureId: null });
    await db.execute(sql`drop trigger refuse_capture on purchases`);
    clock.now = RETRY_AT;

    expect(await runRetryJobs(deps, clock)).toBe(1);

    expect(chargeRequestIds(paypal)).toEqual([chargeRequestId(purchaseId), chargeRequestId(purchaseId)]);
    expect(paypal.captures).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('charges once when PayPal never received the first two attempts', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('ends failed when the replay is declined', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('failed');
    expect(await db.select().from(receipts)).toEqual([]);
  });

  it('throws, leaving the purchase charging and its log as it was, while PayPal still cannot answer', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });
    const before = await eventsOf(db, purchaseId);
    paypal.failNext('chargeSavedWallet', 'network');
    paypal.failNext('chargeSavedWallet', 'network');

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('fetch failed');

    expect(chargeRequestIds(paypal)).toEqual(Array(4).fill(chargeRequestId(purchaseId)));
    expect(await statusOf(db, purchaseId)).toBe('charging');
    expect(await eventsOf(db, purchaseId)).toEqual(before);
  });

  it('does nothing for a purchase that is no longer charging', async () => {
    const { deps, paypal, purchaseId } = await setUp('accepted');

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.calls).toEqual([]);
  });

  it('leaves a pending capture to the webhook that reports it', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
    await chargeAllowed(deps, purchaseId);

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture_pending']);
  });

  it('refuses to replay a charge older than PayPal keeps its request id', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCharge({ lost: false });
    clock.now = new Date(NOW.getTime() + 5 * HOUR_MS + 1);

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('too old to replay');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('refuses to replay a charge once the buyer has unlinked the wallet', async () => {
    const { db, deps, paypal, buyerId, purchaseId } = await setUpUnknownCharge({ lost: false });
    await db.update(wallets).set({ status: 'revoked' }).where(eq(wallets.buyerId, buyerId));

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('no linked wallet');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('refuses a charging purchase that has no saved-wallet charge to replay', async () => {
    const { db, deps, paypal, purchaseId } = await setUp('charging');

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('no saved-wallet charge to replay');

    expect(paypal.calls).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });
});

describe('completeCapture', () => {
  it('takes a pending capture on to its receipt and delivery once PayPal completes it', async () => {
    const { db, deps, paypal, seller, clock, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
    await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;
    clock.now = new Date(NOW.getTime() + 60_000);

    const outcome = await completeCapture(deps, purchaseId, { orderId, captureId });

    const [receipt] = await db.select().from(receipts);
    expect(outcome).toMatchObject({ status: 'accepted', receiptId: receipt.id });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ paypalOrderId: orderId, paypalCaptureId: captureId, capturedAt: clock.now });
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture_pending', 'capture', 'receipt', 'seller_accepted']);
  });

  it('logs a capture that does not match the one recorded, changing nothing', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    const charged = await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;

    const outcome = await completeCapture(deps, purchaseId, { orderId: 'ORDER-9', captureId: 'CAPTURE-9' });

    expect(outcome).toEqual(charged);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'accepted', paypalOrderId: orderId, paypalCaptureId: captureId });
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect((await eventsOf(db, purchaseId)).at(-1)).toEqual({ kind: 'capture_unmatched', data: { captureId: 'CAPTURE-9' } });
  });

  it('logs a capture that does not match the pending one, keeping the stored ids', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
    await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;

    const outcome = await completeCapture(deps, purchaseId, { orderId, captureId: 'CAPTURE-9' });

    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ paypalOrderId: orderId, paypalCaptureId: captureId, capturedAt: null });
    expect(seller.orders).toEqual([]);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture_pending', 'capture_unmatched']);
  });

  it('logs a capture reported for a purchase whose charge was declined', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });
    await chargeAllowed(deps, purchaseId);

    await completeCapture(deps, purchaseId, { orderId: 'ORDER-9', captureId: 'CAPTURE-9' });

    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'failed', paypalOrderId: null, paypalCaptureId: null });
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'charge_declined', 'capture_unmatched']);
  });

  it('does nothing more for a capture already recorded', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    const charged = await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;

    const outcome = await completeCapture(deps, purchaseId, { orderId, captureId });

    expect(outcome).toEqual(charged);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
  });
});
