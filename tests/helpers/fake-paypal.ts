import { PayPalApiError } from '@/lib/paypal/http';
import { PayoutAlreadyExists } from '@/lib/paypal/payouts';
import type { DisputeDetail, PaypalPort } from '@/lib/paypal/port';

// An in-memory PayPal for tests of the purchase flow. It keeps request ids per method the way
// PayPal does: a charge, approval order, capture or refund repeated with the same request id gets
// the first answer and nothing happens twice, while a payout repeated with the same sender batch
// id is refused with PayoutAlreadyExists naming the batch already sent. An approval order can be
// captured only once the test has approved it, as the buyer would at PayPal, and a capture is never
// refunded beyond its amount. A test can make the
// next call of a method fail, and can read back every call and every capture, payout and refund made.

type Method = keyof PaypalPort;
type Answer<M extends Method> = Awaited<ReturnType<PaypalPort[M]>>;

/** One call as the fake received it. */
export type PaypalCall = { [M in Method]: { method: M; args: Parameters<PaypalPort[M]> } }[Method];

type PaymentStatus = 'COMPLETED' | 'PENDING' | 'DECLINED';
/** Methods whose answer carries a payment status a test can choose. */
type PaymentMethod = 'chargeSavedWallet' | 'captureOrder';

/**
 * How the next call of a method goes wrong. `network`: the request never reaches PayPal, so nothing
 * happens, and the call throws as fetch does. `lost_response`: PayPal carries the request out but
 * its answer is lost, so the call throws as fetch does. `{ status }`, for a charge or capture only:
 * PayPal answers with this status instead of COMPLETED.
 */
export type Failure<M extends Method = Method> =
  | 'network'
  | 'lost_response'
  | (M extends PaymentMethod ? { status: Exclude<PaymentStatus, 'COMPLETED'> } : never);

export type FakeCapture = { captureId: string; orderId: string; amountCents: number; status: 'COMPLETED' | 'PENDING' };
export type FakePayout = {
  payoutBatchId: string;
  senderBatchId: string;
  receiverEmail: string;
  amountCents: number;
  note: string;
  batchStatus: string;
  itemStatus: string | null;
};
export type FakeRefund = { refundId: string; captureId: string; amountCents: number; note: string };

const CUSTOMER_ID = 'CUSTOMER-1';

/** What fetch throws when the connection fails. */
function networkError(): TypeError {
  return new TypeError('fetch failed');
}

const ERROR_NAMES: Record<number, string> = { 404: 'RESOURCE_NOT_FOUND', 422: 'UNPROCESSABLE_ENTITY' };

/** The error the PayPal client throws for a 4xx, with PayPal's body: a name and the issue in its details. */
function apiError(status: 404 | 422, path: string, issue: string): PayPalApiError {
  return new PayPalApiError(status, path, JSON.stringify({ name: ERROR_NAMES[status], details: [{ issue }] }));
}

export class FakePaypal implements PaypalPort {
  /** Every call in the order received, including those that failed. */
  readonly calls: PaypalCall[] = [];
  /** Every capture PayPal made, by a charge or by capturing an approved order. */
  readonly captures: FakeCapture[] = [];
  /** Every payout batch PayPal created. */
  readonly payouts: FakePayout[] = [];
  readonly refunds: FakeRefund[] = [];
  /** What listDisputes and getDispute report. */
  disputes: DisputeDetail[] = [];
  /** What verifyWebhook answers. */
  webhookValid = true;

  private readonly failures = new Map<Method, Failure[]>();
  private readonly answers = new Map<string, unknown>();
  private readonly orders = new Map<string, { amountCents: number; approved: boolean; captured: boolean }>();
  private readonly counters = new Map<string, number>();

  /** Makes the next call of `method` that has not already been told to fail go wrong as `failure` says. */
  failNext<M extends Method>(method: M, failure: Failure<M>): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  /** The arguments of each call to `method`, in order. */
  callsTo<M extends Method>(method: M): Parameters<PaypalPort[M]>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args as Parameters<PaypalPort[M]>);
  }

  /** Approves an approval order, as the buyer does on PayPal, so that it can be captured. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`the fake PayPal has no order ${orderId}`);
    order.approved = true;
  }

  /** Sets what getPayoutBatch reports for a batch from now on. */
  setPayoutStatus(payoutBatchId: string, status: { batchStatus: string; itemStatus: string | null }): void {
    const payout = this.payouts.find((p) => p.payoutBatchId === payoutBatchId);
    if (!payout) throw new Error(`the fake PayPal has no payout batch ${payoutBatchId}`);
    Object.assign(payout, status);
  }

  createSetupToken(i: Parameters<PaypalPort['createSetupToken']>[0]) {
    return this.call('createSetupToken', [i], () => {
      const id = this.nextId('SETUP');
      return { id, approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${id}`, customerId: CUSTOMER_ID };
    });
  }

  createPaymentToken(setupTokenId: string) {
    // The client sends `${setupTokenId}:payment-token` as the request id.
    return this.call('createPaymentToken', [setupTokenId], () =>
      this.once('createPaymentToken', setupTokenId, () => ({ id: this.nextId('TOKEN'), customerId: CUSTOMER_ID })),
    );
  }

  chargeSavedWallet(i: Parameters<PaypalPort['chargeSavedWallet']>[0]) {
    return this.call('chargeSavedWallet', [i], (status) =>
      this.once('chargeSavedWallet', i.requestId, () => {
        if (status === 'DECLINED') return { orderId: '', captureId: '', status };
        const orderId = this.nextId('ORDER');
        this.orders.set(orderId, { amountCents: i.amountCents, approved: true, captured: true });
        return { orderId, captureId: this.capture(orderId, i.amountCents, status), status };
      }),
    );
  }

  createApprovalOrder(i: Parameters<PaypalPort['createApprovalOrder']>[0]) {
    return this.call('createApprovalOrder', [i], () =>
      this.once('createApprovalOrder', i.requestId, () => {
        const orderId = this.nextId('ORDER');
        this.orders.set(orderId, { amountCents: i.amountCents, approved: false, captured: false });
        return { orderId, approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}` };
      }),
    );
  }

  /** Captures an approval order once the test has approved it. */
  captureOrder(orderId: string, requestId: string) {
    return this.call('captureOrder', [orderId, requestId], (status) =>
      this.once('captureOrder', requestId, () => {
        const path = `/v2/checkout/orders/${orderId}/capture`;
        const order = this.orders.get(orderId);
        if (!order) throw apiError(404, path, 'RESOURCE_NOT_FOUND');
        if (order.captured) throw apiError(422, path, 'ORDER_ALREADY_CAPTURED');
        if (!order.approved) throw apiError(422, path, 'ORDER_NOT_APPROVED');
        if (status === 'DECLINED') return { captureId: '', status };
        order.captured = true;
        return { captureId: this.capture(orderId, order.amountCents, status), status };
      }),
    );
  }

  createPayout(i: Parameters<PaypalPort['createPayout']>[0]) {
    return this.call('createPayout', [i], () => {
      const sent = this.payouts.find((p) => p.senderBatchId === i.senderBatchId);
      if (sent) throw new PayoutAlreadyExists(i.senderBatchId, sent.payoutBatchId);
      const payoutBatchId = this.nextId('BATCH');
      this.payouts.push({ ...i, payoutBatchId, batchStatus: 'PENDING', itemStatus: 'PENDING' });
      return { payoutBatchId };
    });
  }

  getPayoutBatch(payoutBatchId: string) {
    return this.call('getPayoutBatch', [payoutBatchId], () => {
      const payout = this.payouts.find((p) => p.payoutBatchId === payoutBatchId);
      if (!payout) throw apiError(404, `/v1/payments/payouts/${payoutBatchId}`, 'INVALID_RESOURCE_ID');
      return { batchStatus: payout.batchStatus, itemStatus: payout.itemStatus };
    });
  }

  refundCapture(i: Parameters<PaypalPort['refundCapture']>[0]) {
    return this.call('refundCapture', [i], () =>
      this.once('refundCapture', i.requestId, () => {
        const path = `/v2/payments/captures/${i.captureId}/refund`;
        const capture = this.captures.find((c) => c.captureId === i.captureId);
        if (!capture) throw apiError(404, path, 'RESOURCE_NOT_FOUND');
        const refunded = this.refunds.filter((r) => r.captureId === i.captureId).reduce((sum, r) => sum + r.amountCents, 0);
        if (refunded + i.amountCents > capture.amountCents) throw apiError(422, path, 'REFUND_AMOUNT_EXCEEDED');
        const refundId = this.nextId('REFUND');
        this.refunds.push({ refundId, captureId: i.captureId, amountCents: i.amountCents, note: i.note });
        return { refundId, status: 'COMPLETED' };
      }),
    );
  }

  listDisputes() {
    return this.call('listDisputes', [], () => this.disputes.map((d) => ({ ...d })));
  }

  getDispute(id: string) {
    return this.call('getDispute', [id], () => {
      const dispute = this.disputes.find((d) => d.id === id);
      if (!dispute) throw apiError(404, `/v1/customer/disputes/${id}`, 'INVALID_RESOURCE_ID');
      return { ...dispute };
    });
  }

  provideEvidence(id: string, i: { notes: string }) {
    return this.call('provideEvidence', [id, i], () => undefined);
  }

  verifyWebhook(headers: Headers, rawBody: string) {
    return this.call('verifyWebhook', [headers, rawBody], () => this.webhookValid);
  }

  /**
   * Records the call, then applies the next failure told for `method`, if any, around `carryOut`.
   * `carryOut` gets the payment status to answer with.
   */
  private async call<M extends Method>(
    method: M,
    args: Parameters<PaypalPort[M]>,
    carryOut: (status: PaymentStatus) => Answer<M>,
  ): Promise<Answer<M>> {
    this.calls.push({ method, args } as PaypalCall);
    const failure = this.failures.get(method)?.shift();
    if (failure === 'network') throw networkError();
    const answer = carryOut(typeof failure === 'object' ? failure.status : 'COMPLETED');
    if (failure === 'lost_response') throw networkError();
    return answer;
  }

  /** Carries out a request once per request id; a repeat gets the first answer. A request that throws is not kept. */
  private once<T>(method: Method, requestId: string, carryOut: () => T): T {
    const key = `${method} ${requestId}`;
    if (!this.answers.has(key)) this.answers.set(key, carryOut());
    return this.answers.get(key) as T;
  }

  private capture(orderId: string, amountCents: number, status: 'COMPLETED' | 'PENDING'): string {
    const captureId = this.nextId('CAPTURE');
    this.captures.push({ captureId, orderId, amountCents, status });
    return captureId;
  }

  private nextId(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}
