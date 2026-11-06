import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, type FakeRoute, type RecordedCall } from '@/tests/helpers/fake-fetch';
import approvalOrder from '@/tests/fixtures/paypal/approval-order.json';
import captureCompleted from '@/tests/fixtures/paypal/capture-completed.json';
import { PayPalApiError, resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { captureOrder, createApprovalOrder } from '@/lib/paypal/orders';

const TOKEN_PATH = '/v1/oauth2/token';
const ORDERS = '/v2/checkout/orders';

const APPROVAL_PURCHASE = 'a71e4c92-0d5b-4e83-b6f1-2c9d8e7a5f14';
const APPROVAL_ORDER_ID = '9GT47180MC2365043';
const APPROVAL_CAPTURE = `${ORDERS}/${APPROVAL_ORDER_ID}/capture`;

const oauth: FakeRoute = {
  method: 'POST',
  path: TOKEN_PATH,
  body: { access_token: 'T1', token_type: 'Bearer', expires_in: 32_400 },
};

/** A PayPal 422 carrying one issue, in the shape PayPal sends. */
const unprocessable = (path: string, issue: string): FakeRoute => ({
  method: 'POST',
  path,
  status: 422,
  body: {
    name: 'UNPROCESSABLE_ENTITY',
    details: [{ issue, description: `PayPal reported ${issue}.` }],
    message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
    debug_id: 'f2a8c51e7b3d9',
    links: [{ href: `https://developer.paypal.com/docs/api/orders/v2/#error-${issue}`, rel: 'information_link', method: 'GET' }],
  },
});

/** The order with its first capture's status replaced. */
function withCaptureStatus<T extends typeof captureCompleted>(order: T, status: string): T {
  const [unit] = order.purchase_units;
  const [capture] = unit.payments.captures;
  return { ...order, purchase_units: [{ ...unit, payments: { captures: [{ ...capture, status }] } }] };
}

function stubFetch(routes: FakeRoute[]): RecordedCall[] {
  const f = fakeFetch([oauth, ...routes]);
  vi.stubGlobal('fetch', f.fetch);
  return f.calls;
}

const apiCalls = (calls: RecordedCall[]) => calls.filter((c) => new URL(c.url).pathname !== TOKEN_PATH);

beforeEach(() => {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  resetPaypalTokenCacheForTests();
  setPaypalRetrySleepForTests(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createApprovalOrder', () => {
  const approvalInput = {
    amountCents: 6400,
    description: 'Espresso grinder from North Fork Coffee',
    invoiceId: APPROVAL_PURCHASE,
    returnUrl: 'https://behest.test/purchases/approved',
    cancelUrl: 'https://behest.test/purchases/cancelled',
    requestId: `${APPROVAL_PURCHASE}:approval`,
  };

  it('creates an order for the buyer to approve and pay on PayPal', async () => {
    const calls = stubFetch([{ method: 'POST', path: ORDERS, body: approvalOrder }]);

    await createApprovalOrder(approvalInput);

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(post.headers['paypal-request-id']).toBe(`${APPROVAL_PURCHASE}:approval`);
    expect(JSON.parse(post.body ?? '')).toEqual({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: 'USD', value: '64.00' },
          description: 'Espresso grinder from North Fork Coffee',
          invoice_id: APPROVAL_PURCHASE,
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: 'https://behest.test/purchases/approved',
            cancel_url: 'https://behest.test/purchases/cancelled',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            brand_name: 'Behest',
          },
        },
      },
    });
  });

  it('returns the order id and the payer-action link', async () => {
    stubFetch([{ method: 'POST', path: ORDERS, body: approvalOrder }]);

    expect(await createApprovalOrder(approvalInput)).toEqual({
      orderId: APPROVAL_ORDER_ID,
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=9GT47180MC2365043',
    });
  });

  it('prefers the payer-action link and falls back to the approve link', async () => {
    const approve = { href: 'https://www.sandbox.paypal.com/checkoutnow?token=APPROVE', rel: 'approve', method: 'GET' };
    stubFetch([{ method: 'POST', path: ORDERS, body: { ...approvalOrder, links: [approve, ...approvalOrder.links] } }]);
    expect((await createApprovalOrder(approvalInput)).approveUrl).toBe(
      'https://www.sandbox.paypal.com/checkoutnow?token=9GT47180MC2365043',
    );

    const links = [...approvalOrder.links.filter((link) => link.rel !== 'payer-action'), approve];
    stubFetch([{ method: 'POST', path: ORDERS, body: { ...approvalOrder, status: 'CREATED', links } }]);
    expect((await createApprovalOrder(approvalInput)).approveUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=APPROVE');
  });

  it('fails, naming the order, when PayPal sends no link for the buyer', async () => {
    const links = approvalOrder.links.filter((link) => link.rel !== 'payer-action');
    stubFetch([{ method: 'POST', path: ORDERS, body: { ...approvalOrder, links } }]);

    await expect(createApprovalOrder(approvalInput)).rejects.toThrow(/9GT47180MC2365043/);
  });
});

describe('captureOrder', () => {
  const requestId = `${APPROVAL_PURCHASE}:capture`;

  it('captures the approved order and returns the capture id', async () => {
    const calls = stubFetch([{ method: 'POST', path: APPROVAL_CAPTURE, status: 201, body: captureCompleted }]);

    expect(await captureOrder(APPROVAL_ORDER_ID, requestId)).toEqual({
      captureId: '2FN86302RL1957468',
      status: 'COMPLETED',
    });

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders/9GT47180MC2365043/capture');
    expect(post.headers['paypal-request-id']).toBe(requestId);
    expect(JSON.parse(post.body ?? '')).toEqual({});
  });

  it.each([
    ['PENDING', 'PENDING'],
    ['DECLINED', 'DECLINED'],
    ['FAILED', 'DECLINED'],
  ])('reports a %s capture as %s', async (captureStatus, status) => {
    const body = withCaptureStatus(captureCompleted, captureStatus);
    stubFetch([{ method: 'POST', path: APPROVAL_CAPTURE, status: 201, body }]);

    expect(await captureOrder(APPROVAL_ORDER_ID, requestId)).toEqual({ captureId: '2FN86302RL1957468', status });
  });

  it('reports a declined instrument as declined, with no capture', async () => {
    stubFetch([unprocessable(APPROVAL_CAPTURE, 'INSTRUMENT_DECLINED')]);

    expect(await captureOrder(APPROVAL_ORDER_ID, requestId)).toEqual({ captureId: '', status: 'DECLINED' });
  });

  it('rethrows any other PayPal error', async () => {
    stubFetch([unprocessable(APPROVAL_CAPTURE, 'ORDER_ALREADY_CAPTURED')]);

    const error = await captureOrder(APPROVAL_ORDER_ID, requestId).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 422, body: expect.stringContaining('ORDER_ALREADY_CAPTURED') });
  });

  it('fails, naming the order, when the response has no capture', async () => {
    const noCapture = { ...captureCompleted, purchase_units: [{ reference_id: 'default' }] };
    stubFetch([{ method: 'POST', path: APPROVAL_CAPTURE, status: 201, body: noCapture }]);

    await expect(captureOrder(APPROVAL_ORDER_ID, requestId)).rejects.toThrow(/9GT47180MC2365043/);
  });
});
