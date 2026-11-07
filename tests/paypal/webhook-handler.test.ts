import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchases, receipts, refunds, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue } from '@/lib/jobs/queue';
import { handleWebhook } from '@/lib/paypal/webhook-handler';
import { completeApproval, startApproval } from '@/lib/purchases/approval';
import { chargeAllowed } from '@/lib/purchases/charge';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { NOW, setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf, purchaseRow, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

type Setup = Awaited<ReturnType<typeof setUp>>;

let eventCount = 0;

/** A verified PayPal webhook event, as stored, with a fresh event id. */
function webhook(eventType: string, resource: Record<string, unknown>): Record<string, unknown> {
  eventCount += 1;
  return { id: `WH-${eventCount}`, event_type: eventType, resource_type: 'test', resource };
}

const orderApproved = (orderId: string) => webhook('CHECKOUT.ORDER.APPROVED', { id: orderId, status: 'APPROVED' });

/** A capture event as PayPal sends it: the capture, its invoice id and the order it belongs to. */
function captureEvent(
  eventType: 'PAYMENT.CAPTURE.COMPLETED' | 'PAYMENT.CAPTURE.DENIED',
  { captureId, orderId, invoiceId }: { captureId: string; orderId: string; invoiceId?: string },
) {
  return webhook(eventType, {
    id: captureId,
    status: eventType === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED' : 'DECLINED',
    amount: { currency_code: 'USD', value: '18.75' },
    ...(invoiceId === undefined ? {} : { invoice_id: invoiceId }),
    supplementary_data: { related_ids: { order_id: orderId } },
  });
}

/** A refund event as PayPal sends it: the refund, linking `up` to the capture it refunds. */
function refunded({ refundId, captureId, value = '18.75' }: { refundId: string; captureId: string; value?: string }) {
  return webhook('PAYMENT.CAPTURE.REFUNDED', {
    id: refundId,
    status: 'COMPLETED',
    amount: { currency_code: 'USD', value },
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${refundId}`, rel: 'self', method: 'GET' },
      { href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}`, rel: 'up', method: 'GET' },
    ],
  });
}

function payoutItem(eventType: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' | 'PAYMENT.PAYOUTS-ITEM.FAILED', payoutBatchId: string) {
  return webhook(eventType, {
    payout_item_id: 'ITEM-1',
    payout_batch_id: payoutBatchId,
    transaction_status: eventType === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' ? 'SUCCESS' : 'FAILED',
  });
}

/** Everything a webhook could change, to show that handling an event again changes none of it. */
async function snapshot({ db, paypal, purchaseId }: { db: Db; paypal: FakePaypal; purchaseId: string }) {
  return {
    purchase: await purchaseRow(db, purchaseId),
    events: await eventsOf(db, purchaseId),
    jobs: await db.select().from(jobs).orderBy(jobs.id),
    refunds: await db.select().from(refunds).orderBy(refunds.id),
    payouts: await db.select().from(payouts),
    receipts: await db.select().from(receipts),
    paypalCalls: paypal.calls.length,
  };
}

/** The queued jobs, by kind, payload and when they are due. */
async function queued(db: Db) {
  return db.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs).where(eq(jobs.status, 'queued'));
}

/** A purchase the gate sent to its buyer, its approval order created at PayPal and approved there. */
async function setUpAwaiting() {
  const s = await setUp('proposed', { wallet: null });
  await s.db
    .update(purchases)
    .set({ gateVerdict: 'ASK', finalVerdict: 'ASK', approver: null })
    .where(eq(purchases.id, s.purchaseId));
  await startApproval(s.deps, s.purchaseId);
  const { paypalOrderId: orderId } = await purchaseRow(s.db, s.purchaseId);
  if (!orderId) throw new Error('the approval was not started');
  s.paypal.approve(orderId);
  return { ...s, orderId };
}

/** An approved purchase left `charging` with no capture, its two capture attempts lost on the way to PayPal. */
async function setUpUnknownCapture() {
  const s = await setUpAwaiting();
  s.paypal.failNext('captureOrder', 'network');
  s.paypal.failNext('captureOrder', 'network');
  await completeApproval(s.deps, s.orderId);
  return s;
}

/** An allowed purchase whose saved-wallet charge PayPal is holding: `charging`, with its capture PENDING. */
async function setUpPendingCapture() {
  const s = await setUp('proposed');
  s.paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
  await chargeAllowed(s.deps, s.purchaseId);
  const { paypalOrderId: orderId, paypalCaptureId: captureId } = await purchaseRow(s.db, s.purchaseId);
  if (!orderId || !captureId) throw new Error('the pending capture was not stored');
  return { ...s, orderId, captureId };
}

/** A captured purchase moved on to `status`, with its seller's payout `payoutStatus` on record. */
async function setUpPaid(status: PurchaseStatus, payoutStatus = 'SUCCESS') {
  const s = await setUpCaptured();
  await s.db.update(purchases).set({ status }).where(eq(purchases.id, s.purchaseId));
  await s.db.insert(payouts).values({
    purchaseId: s.purchaseId,
    sellerId: s.sellerId,
    amountCents: 1875,
    senderBatchId: `${s.purchaseId}:payout`,
    paypalBatchId: 'BATCH-7',
    status: payoutStatus,
  });
  return s;
}

/** Handles the event, then handles it again and checks that the second time changed nothing. */
async function handleTwice(s: Pick<Setup, 'db' | 'paypal' | 'purchaseId' | 'deps'>, event: Record<string, unknown>) {
  await handleWebhook(s.deps, event);
  const once = await snapshot(s);
  await handleWebhook(s.deps, event);
  expect(await snapshot(s)).toEqual(once);
}

describe('handleWebhook: CHECKOUT.ORDER.APPROVED', () => {
  it('captures the order of a purchase awaiting approval and carries it on to its seller, once', async () => {
    const s = await setUpAwaiting();

    await handleTwice(s, orderApproved(s.orderId));

    expect(s.paypal.callsTo('captureOrder')).toEqual([[s.orderId, `${s.purchaseId}:capture`]]);
    expect(await purchaseRow(s.db, s.purchaseId)).toMatchObject({ status: 'accepted', approver: 'human' });
    expect(await s.db.select().from(receipts)).toHaveLength(1);
  });

  it('ignores an order no purchase holds, logging it once and throwing nothing', async () => {
    const s = await setUpAwaiting();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);
    const event = orderApproved('ORDER-NOBODY');

    await expect(handleWebhook(s.deps, event)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('ORDER-NOBODY');
    expect(await snapshot(s)).toEqual(before);
  });

  it('never touches a saved-wallet purchase holding the order', async () => {
    const s = await setUp('charging');
    await s.db.update(purchases).set({ paypalOrderId: 'ORDER-9' }).where(eq(purchases.id, s.purchaseId));
    const before = await snapshot(s);

    await handleWebhook(s.deps, orderApproved('ORDER-9'));

    expect(await snapshot(s)).toEqual(before);
    expect(s.paypal.calls).toEqual([]);
  });

  it('leaves a purchase already captured as it is', async () => {
    const s = await setUpCaptured('ASK');
    const before = await snapshot(s);

    await handleWebhook(s.deps, orderApproved(s.orderId));

    expect(await snapshot(s)).toEqual(before);
  });

  it('asks PayPal nothing for an approved purchase already charging with no capture, leaving it to its replay', async () => {
    const s = await setUpUnknownCapture();
    const before = await snapshot(s);

    await handleWebhook(s.deps, orderApproved(s.orderId));

    expect(await snapshot(s)).toEqual(before);
    expect(await statusOf(s.db, s.purchaseId)).toBe('charging');
  });
});

describe('handleWebhook: PAYMENT.CAPTURE.COMPLETED', () => {
  it('completes a pending capture found by its stored capture id, issuing the receipt and delivering the order once', async () => {
    const s = await setUpPendingCapture();

    await handleTwice(s, captureEvent('PAYMENT.CAPTURE.COMPLETED', { captureId: s.captureId, orderId: s.orderId, invoiceId: s.purchaseId }));

    expect(await purchaseRow(s.db, s.purchaseId)).toMatchObject({ status: 'accepted', paypalCaptureId: s.captureId, capturedAt: NOW });
    expect(await s.db.select().from(receipts)).toHaveLength(1);
    expect(s.paypal.payouts).toHaveLength(1);
  });

  it('matches a charging purchase with no capture by its invoice id and its stored order, and completes it once', async () => {
    const s = await setUpUnknownCapture();

    await handleTwice(s, captureEvent('PAYMENT.CAPTURE.COMPLETED', { captureId: 'CAPTURE-77', orderId: s.orderId, invoiceId: s.purchaseId }));

    expect(await purchaseRow(s.db, s.purchaseId)).toMatchObject({ status: 'accepted', paypalOrderId: s.orderId, paypalCaptureId: 'CAPTURE-77' });
    expect((await eventsOf(s.db, s.purchaseId)).filter((e) => e.kind === 'capture')).toEqual([
      { kind: 'capture', data: { orderId: s.orderId, captureId: 'CAPTURE-77' } },
    ]);
    expect(await s.db.select().from(receipts)).toHaveLength(1);
  });

  it.each([
    ['an order other than the one the purchase holds', { orderId: 'ORDER-OTHER' }],
    ['an invoice id that is not a purchase id', { invoiceId: 'INV-2026-0001' }],
    ['no invoice id', { invoiceId: undefined }],
  ])('moves nothing for a capture with %s, logging it', async (_, changes) => {
    const s = await setUpUnknownCapture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(
      s.deps,
      captureEvent('PAYMENT.CAPTURE.COMPLETED', { captureId: 'CAPTURE-77', orderId: s.orderId, invoiceId: s.purchaseId, ...changes }),
    );

    expect(await snapshot(s)).toEqual(before);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('never matches a saved-wallet charge by invoice id, since Behest has stored no order for it', async () => {
    const s = await setUp('proposed');
    s.paypal.failNext('chargeSavedWallet', 'lost_response');
    s.paypal.failNext('chargeSavedWallet', 'lost_response');
    await chargeAllowed(s.deps, s.purchaseId);
    const [{ captureId, orderId }] = s.paypal.captures;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(s.deps, captureEvent('PAYMENT.CAPTURE.COMPLETED', { captureId, orderId, invoiceId: s.purchaseId }));

    expect(await snapshot(s)).toEqual(before);
    expect(await statusOf(s.db, s.purchaseId)).toBe('charging');
  });
});

describe('handleWebhook: PAYMENT.CAPTURE.DENIED', () => {
  it('fails a charging purchase holding the capture, with an event, once', async () => {
    const s = await setUpPendingCapture();

    await handleTwice(s, captureEvent('PAYMENT.CAPTURE.DENIED', { captureId: s.captureId, orderId: s.orderId }));

    expect(await statusOf(s.db, s.purchaseId)).toBe('failed');
    expect((await eventsOf(s.db, s.purchaseId)).slice(-2)).toEqual([
      { kind: 'capture_denied', data: { captureId: s.captureId } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
    expect(await s.db.select().from(receipts)).toEqual([]);
  });

  it('leaves a purchase whose capture has completed as it is', async () => {
    const s = await setUpCaptured();
    const before = await snapshot(s);

    await handleWebhook(s.deps, captureEvent('PAYMENT.CAPTURE.DENIED', { captureId: s.captureId, orderId: s.orderId }));

    expect(await snapshot(s)).toEqual(before);
  });

  it('logs a denied capture no purchase holds and moves nothing', async () => {
    const s = await setUpPendingCapture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(s.deps, captureEvent('PAYMENT.CAPTURE.DENIED', { captureId: 'CAPTURE-NOBODY', orderId: s.orderId }));

    expect(await snapshot(s)).toEqual(before);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('handleWebhook: PAYMENT.CAPTURE.REFUNDED', () => {
  it('records a refund made outside Behest on a settled purchase and moves it to refunded, once, refunding nothing', async () => {
    const s = await setUpPaid('settled');

    await handleTwice(s, refunded({ refundId: 'REFUND-EXT-1', captureId: s.captureId }));

    expect(await s.db.select().from(refunds)).toEqual([
      expect.objectContaining({ purchaseId: s.purchaseId, amountCents: 1875, paypalRefundId: 'REFUND-EXT-1', status: 'COMPLETED' }),
    ]);
    expect((await eventsOf(s.db, s.purchaseId)).slice(-2)).toEqual([
      { kind: 'refund_external', data: { refundId: 'REFUND-EXT-1', status: 'COMPLETED', amountCents: 1875, payoutStatus: 'SUCCESS' } },
      { kind: 'status', data: { from: 'settled', to: 'refunded' } },
    ]);
    expect(await statusOf(s.db, s.purchaseId)).toBe('refunded');
    expect(s.paypal.callsTo('refundCapture')).toEqual([]);
  });

  it.each<PurchaseStatus>(['captured', 'accepted', 'disputed'])('moves a %s purchase to refunded', async (status) => {
    const s = await setUpPaid(status, 'PENDING');

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-EXT-1', captureId: s.captureId }));

    expect(await statusOf(s.db, s.purchaseId)).toBe('refunded');
  });

  it('records a partial refund without moving the purchase, and moves it once the refunds reach its total', async () => {
    const s = await setUpPaid('settled');

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-EXT-1', captureId: s.captureId, value: '5.00' }));

    expect(await statusOf(s.db, s.purchaseId)).toBe('settled');
    expect((await s.db.select().from(refunds)).map((r) => r.amountCents)).toEqual([500]);

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-EXT-2', captureId: s.captureId, value: '13.75' }));

    expect(await statusOf(s.db, s.purchaseId)).toBe('refunded');
    expect((await s.db.select().from(refunds)).map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([500, 1375]);
  });

  it('is a quiet no-op for a refund Behest made itself and has already recorded', async () => {
    const s = await setUpCaptured();
    await s.db.update(purchases).set({ status: 'refunded' }).where(eq(purchases.id, s.purchaseId));
    await s.db
      .insert(refunds)
      .values({ purchaseId: s.purchaseId, amountCents: 1875, paypalRefundId: 'REFUND-1', status: 'COMPLETED', reason: 'Rejected.' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-1', captureId: s.captureId }));

    expect(await snapshot(s)).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves a refund to Behest's own refund of the purchase while that still awaits PayPal's answer", async () => {
    const s = await setUpCaptured();
    await s.db.insert(refunds).values({ purchaseId: s.purchaseId, amountCents: 1875, reason: 'Rejected.' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-1', captureId: s.captureId }));

    expect(await snapshot(s)).toEqual(before);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('logs a refund of a capture no purchase holds and records nothing', async () => {
    const s = await setUpPaid('settled');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const before = await snapshot(s);

    await handleWebhook(s.deps, refunded({ refundId: 'REFUND-EXT-1', captureId: 'CAPTURE-NOBODY' }));

    expect(await snapshot(s)).toEqual(before);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('handleWebhook: disputes', () => {
  it.each(['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED'])('queues one dispute sync, due now, for %s', async (eventType) => {
    const s = await setUp('settled');

    await handleTwice(s, webhook(eventType, { dispute_id: 'PP-D-1001' }));

    expect(await queued(s.db)).toEqual([{ kind: 'dispute_sync', payload: {}, runAt: NOW }]);
  });

  it('brings a dispute sync queued for later forward instead of queuing another', async () => {
    const s = await setUp('settled');
    await enqueue(s.db, 'dispute_sync', {}, new Date(NOW.getTime() + 10 * 60 * 1000));

    await handleWebhook(s.deps, webhook('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'PP-D-1001' }));

    expect(await queued(s.db)).toEqual([{ kind: 'dispute_sync', payload: {}, runAt: NOW }]);
  });
});

describe('handleWebhook: PAYMENT.PAYOUTS-ITEM', () => {
  it.each(['PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.FAILED'] as const)(
    'queues one payout poll, due now, for the purchase whose payout holds the batch on %s, recording nothing itself',
    async (eventType) => {
      const s = await setUpPaid('accepted', 'PENDING');

      await handleTwice(s, payoutItem(eventType, 'BATCH-7'));

      expect(await queued(s.db)).toEqual([{ kind: 'payout_poll', payload: { purchaseId: s.purchaseId }, runAt: NOW }]);
      expect(await s.db.select({ status: payouts.status }).from(payouts)).toEqual([{ status: 'PENDING' }]);
      expect(await statusOf(s.db, s.purchaseId)).toBe('accepted');
      expect(s.paypal.callsTo('getPayoutBatch')).toEqual([]);
    },
  );

  it("brings the payout's queued poll forward instead of queuing another", async () => {
    const s = await setUpPaid('accepted', 'PENDING');
    await enqueue(s.db, 'payout_poll', { purchaseId: s.purchaseId }, new Date(NOW.getTime() + 30_000));

    await handleWebhook(s.deps, payoutItem('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'BATCH-7'));

    expect(await queued(s.db)).toEqual([{ kind: 'payout_poll', payload: { purchaseId: s.purchaseId }, runAt: NOW }]);
  });

  it('logs a payout item of a batch no payout holds and queues nothing', async () => {
    const s = await setUpPaid('accepted', 'PENDING');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleWebhook(s.deps, payoutItem('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'BATCH-NOBODY'));

    expect(await queued(s.db)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('handleWebhook: other events', () => {
  it('quietly does nothing for an event type it does not act on', async () => {
    const s = await setUpPaid('settled');
    const logs = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'log')];
    const before = await snapshot(s);

    await handleWebhook(s.deps, webhook('BILLING.SUBSCRIPTION.CREATED', { id: 'I-1' }));

    expect(await snapshot(s)).toEqual(before);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ['an event with no id', { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-1' } }],
    ['an approval with no order id', webhook('CHECKOUT.ORDER.APPROVED', { status: 'APPROVED' })],
    ['a refund with no link to its capture', webhook('PAYMENT.CAPTURE.REFUNDED', { id: 'R-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } })],
    ['a refund in another currency', webhook('PAYMENT.CAPTURE.REFUNDED', { id: 'R-1', status: 'COMPLETED', amount: { currency_code: 'EUR', value: '1.00' }, links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/C-1' }] })],
    ['a payout item with no batch', webhook('PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_item_id: 'ITEM-1' })],
  ])('throws, changing nothing, for %s', async (_, event) => {
    const s = await setUpPaid('settled');
    const before = await snapshot(s);

    await expect(handleWebhook(s.deps, event)).rejects.toThrow();

    expect(await snapshot(s)).toEqual(before);
  });
});
