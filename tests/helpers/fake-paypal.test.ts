import { describe, expect, it } from 'vitest';
import { PayPalApiError } from '@/lib/paypal/http';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import { FakePaypal } from '@/tests/helpers/fake-paypal';

// The fake stands in for PayPal in every purchase-flow test, so its request-id handling has to
// match PayPal's: these tests pin it down.

const charge = (requestId: string) => ({
  paymentTokenId: 'TOKEN-1',
  amountCents: 1875,
  description: 'Behest order',
  invoiceId: 'purchase-1',
  requestId,
});

const approvalOrder = {
  amountCents: 3200,
  description: 'Behest order',
  invoiceId: 'purchase-1',
  returnUrl: 'http://localhost:3000/api/purchases/return',
  cancelUrl: 'http://localhost:3000/buyer/approvals',
  requestId: 'purchase-1:approval',
};

/** The issue PayPal names in a 422 body. */
function issueOf(error: unknown): unknown {
  return error instanceof PayPalApiError ? JSON.parse(error.body).details?.[0]?.issue : undefined;
}

const payout = { receiverEmail: 'payouts@ravi-spices.example.com', amountCents: 1875, note: 'Behest order', senderBatchId: 'purchase-1:payout' };

describe('charges and captures', () => {
  it('answers a charge repeated with the same request id with the first charge, capturing once', async () => {
    const paypal = new FakePaypal();

    const first = await paypal.chargeSavedWallet(charge('purchase-1:charge'));
    const again = await paypal.chargeSavedWallet(charge('purchase-1:charge'));

    expect(first.status).toBe('COMPLETED');
    expect(again).toEqual(first);
    expect(paypal.captures).toEqual([{ captureId: first.captureId, orderId: first.orderId, amountCents: 1875, status: 'COMPLETED' }]);
  });

  it('charges again under a new request id', async () => {
    const paypal = new FakePaypal();

    await paypal.chargeSavedWallet(charge('purchase-1:charge'));
    await paypal.chargeSavedWallet(charge('purchase-2:charge'));

    expect(paypal.captures).toHaveLength(2);
  });

  it('charges when only the response is lost, so a retry with the same request id finds that charge', async () => {
    const paypal = new FakePaypal();
    paypal.failNext('chargeSavedWallet', 'lost_response');

    await expect(paypal.chargeSavedWallet(charge('purchase-1:charge'))).rejects.toThrow(TypeError);
    expect(paypal.captures).toHaveLength(1);
    const retried = await paypal.chargeSavedWallet(charge('purchase-1:charge'));

    expect(retried.captureId).toBe(paypal.captures[0].captureId);
    expect(paypal.captures).toHaveLength(1);
  });

  it('charges nothing when the request is lost', async () => {
    const paypal = new FakePaypal();
    paypal.failNext('chargeSavedWallet', 'network');

    await expect(paypal.chargeSavedWallet(charge('purchase-1:charge'))).rejects.toThrow(TypeError);

    expect(paypal.captures).toEqual([]);
  });

  it('fails as many calls as it was told to, in turn', async () => {
    const paypal = new FakePaypal();
    paypal.failNext('chargeSavedWallet', 'network');
    paypal.failNext('chargeSavedWallet', 'network');

    await expect(paypal.chargeSavedWallet(charge('purchase-1:charge'))).rejects.toThrow(TypeError);
    await expect(paypal.chargeSavedWallet(charge('purchase-1:charge'))).rejects.toThrow(TypeError);
    await expect(paypal.chargeSavedWallet(charge('purchase-1:charge'))).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('answers a charge with a chosen status, and a declined charge captures nothing', async () => {
    const paypal = new FakePaypal();
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });

    const declined = await paypal.chargeSavedWallet(charge('purchase-1:charge'));

    expect(declined).toEqual({ orderId: '', captureId: '', status: 'DECLINED' });
    expect(paypal.captures).toEqual([]);
    expect(await paypal.chargeSavedWallet(charge('purchase-1:charge'))).toEqual(declined);
  });

  it('captures an approved order once, and refuses a second capture under a new request id', async () => {
    const paypal = new FakePaypal();
    const { orderId } = await paypal.createApprovalOrder(approvalOrder);
    paypal.approve(orderId);

    const first = await paypal.captureOrder(orderId, 'purchase-1:capture');
    const replayed = await paypal.captureOrder(orderId, 'purchase-1:capture');
    const refused = paypal.captureOrder(orderId, 'another-request');

    expect(replayed).toEqual(first);
    await expect(refused).rejects.toBeInstanceOf(PayPalApiError);
    await expect(refused).rejects.toMatchObject({ status: 422 });
    expect(paypal.captures).toEqual([{ captureId: first.captureId, orderId, amountCents: 3200, status: 'COMPLETED' }]);
  });

  it('refuses to capture an approval order the buyer has not approved, then captures it once approved', async () => {
    const paypal = new FakePaypal();
    const { orderId } = await paypal.createApprovalOrder(approvalOrder);

    const refused = await paypal.captureOrder(orderId, 'purchase-1:capture').catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PayPalApiError);
    expect(refused).toMatchObject({ status: 422 });
    expect(issueOf(refused)).toBe('ORDER_NOT_APPROVED');
    expect(paypal.captures).toEqual([]);
    paypal.approve(orderId);
    await expect(paypal.captureOrder(orderId, 'purchase-1:capture')).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('cannot approve an order it never created', () => {
    expect(() => new FakePaypal().approve('ORDER-404')).toThrow('ORDER-404');
  });

  it('refunds a capture once per request id', async () => {
    const paypal = new FakePaypal();
    const { captureId } = await paypal.chargeSavedWallet(charge('purchase-1:charge'));
    const refund = { captureId, amountCents: 1875, note: 'The seller could not take the order', requestId: 'purchase-1:refund' };

    const first = await paypal.refundCapture(refund);
    const again = await paypal.refundCapture(refund);

    expect(again).toEqual(first);
    expect(paypal.refunds).toEqual([{ refundId: first.refundId, captureId, amountCents: 1875, note: refund.note }]);
  });

  it('refuses a refund beyond what is left of the capture, while a repeated request id still gets its first answer', async () => {
    const paypal = new FakePaypal();
    const { captureId } = await paypal.chargeSavedWallet(charge('purchase-1:charge'));
    const refund = (amountCents: number, requestId: string) => ({ captureId, amountCents, note: 'Partly refunded', requestId });
    const first = await paypal.refundCapture(refund(1000, 'refund-1'));

    const refused = await paypal.refundCapture(refund(900, 'refund-2')).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PayPalApiError);
    expect(refused).toMatchObject({ status: 422 });
    expect(issueOf(refused)).toBe('REFUND_AMOUNT_EXCEEDED');
    expect(await paypal.refundCapture(refund(1000, 'refund-1'))).toEqual(first);
    await expect(paypal.refundCapture(refund(875, 'refund-3'))).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(paypal.refunds.map((r) => r.amountCents)).toEqual([1000, 875]);
  });
});

describe('payouts', () => {
  it('refuses a payout repeated with the same sender batch id, naming the batch already sent', async () => {
    const paypal = new FakePaypal();
    const { payoutBatchId } = await paypal.createPayout(payout);

    const repeated = paypal.createPayout(payout);

    await expect(repeated).rejects.toBeInstanceOf(PayoutAlreadyExists);
    await expect(repeated).rejects.toMatchObject({ senderBatchId: payout.senderBatchId, payoutBatchId });
    expect(paypal.payouts).toHaveLength(1);
  });

  it('sends the payout when only the response is lost, so the retry is refused as a repeat', async () => {
    const paypal = new FakePaypal();
    paypal.failNext('createPayout', 'lost_response');

    await expect(paypal.createPayout(payout)).rejects.toThrow(TypeError);

    await expect(paypal.createPayout(payout)).rejects.toMatchObject({ payoutBatchId: paypal.payouts[0].payoutBatchId });
    expect(paypal.payouts).toHaveLength(1);
  });

  it('reports a new payout as pending, then the status a test sets', async () => {
    const paypal = new FakePaypal();
    const { payoutBatchId } = await paypal.createPayout(payout);

    expect(await paypal.getPayoutBatch(payoutBatchId)).toEqual({ batchStatus: 'PENDING', itemStatus: 'PENDING' });
    paypal.setPayoutStatus(payoutBatchId, { batchStatus: 'SUCCESS', itemStatus: 'RETURNED' });
    expect(await paypal.getPayoutBatch(payoutBatchId)).toEqual({ batchStatus: 'SUCCESS', itemStatus: 'RETURNED' });
  });
});

it('records every call in order, including the ones that failed', async () => {
  const paypal = new FakePaypal();
  paypal.failNext('createPayout', 'network');

  await expect(paypal.createPayout(payout)).rejects.toThrow(TypeError);
  await paypal.createPayout(payout);
  await paypal.getPayoutBatch(paypal.payouts[0].payoutBatchId);

  expect(paypal.calls.map((c) => c.method)).toEqual(['createPayout', 'createPayout', 'getPayoutBatch']);
  expect(paypal.callsTo('createPayout')).toEqual([[payout], [payout]]);
});
