import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCalls, stubFetch, stubFetchLosingFirstResponse } from '@/tests/helpers/paypal-fetch';
import refundCompleted from '@/tests/fixtures/paypal/refund-completed.json';
import { PayPalApiError, resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { refundCapture } from '@/lib/paypal/refunds';

const PURCHASE = 'a71e4c92-0d5b-4e83-b6f1-2c9d8e7a5f14';
const CAPTURE_ID = '2FN86302RL1957468';
const REFUND_PATH = `/v2/payments/captures/${CAPTURE_ID}/refund`;
const REFUND_ID = '0LT61953WD8340275';

const refundInput = {
  captureId: CAPTURE_ID,
  amountCents: 6400,
  note: 'North Fork Coffee could not fill this order, so your payment is refunded.',
  requestId: `${PURCHASE}:refund`,
};

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

describe('refundCapture', () => {
  it("refunds the capture from Behest's account, keyed on the refund request id", async () => {
    const calls = stubFetch([{ method: 'POST', path: REFUND_PATH, status: 201, body: refundCompleted }]);

    await refundCapture(refundInput);

    const [post] = apiCalls(calls);
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/2FN86302RL1957468/refund');
    expect(post.headers['paypal-request-id']).toBe(`${PURCHASE}:refund`);
    expect(JSON.parse(post.body ?? '')).toEqual({
      amount: { value: '64.00', currency_code: 'USD' },
      note_to_payer: 'North Fork Coffee could not fill this order, so your payment is refunded.',
    });
  });

  it('returns the refund id and its status', async () => {
    stubFetch([{ method: 'POST', path: REFUND_PATH, status: 201, body: refundCompleted }]);

    expect(await refundCapture(refundInput)).toEqual({ refundId: REFUND_ID, status: 'COMPLETED' });
  });

  it.each(['PENDING', 'FAILED', 'CANCELLED'])('reports a %s refund as PayPal sent it', async (status) => {
    stubFetch([{ method: 'POST', path: REFUND_PATH, status: 201, body: { ...refundCompleted, status } }]);

    expect(await refundCapture(refundInput)).toEqual({ refundId: REFUND_ID, status });
  });

  it('encodes the capture id, so it stays one segment of the refund path', async () => {
    const calls = stubFetch([{ method: 'POST', path: '/v2/payments/captures/AB%2FCD%3Fx%3D1/refund', status: 201, body: refundCompleted }]);

    await refundCapture({ ...refundInput, captureId: 'AB/CD?x=1' });

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v2/payments/captures/AB%2FCD%3Fx%3D1/refund');
  });

  it('rethrows a PayPal error untouched', async () => {
    const body = {
      name: 'UNPROCESSABLE_ENTITY',
      details: [{ issue: 'CAPTURE_FULLY_REFUNDED', description: 'The capture has already been fully refunded.' }],
      message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
      debug_id: '7e4b19d2a6c83',
    };
    stubFetch([{ method: 'POST', path: REFUND_PATH, status: 422, body }]);

    const error = await refundCapture(refundInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 422, body: JSON.stringify(body) });
  });

  it('repeats a refund whose response was lost with the same PayPal-Request-Id and body', async () => {
    const { calls, lost } = stubFetchLosingFirstResponse([{ method: 'POST', path: REFUND_PATH, status: 201, body: refundCompleted }], REFUND_PATH);

    await expect(refundCapture(refundInput)).rejects.toBe(lost);
    expect(await refundCapture(refundInput)).toEqual({ refundId: REFUND_ID, status: 'COMPLETED' });

    const posts = apiCalls(calls);
    expect(posts.map((c) => c.headers['paypal-request-id'])).toEqual([`${PURCHASE}:refund`, `${PURCHASE}:refund`]);
    expect(posts[1].body).toBe(posts[0].body);
  });

  it.each([
    { name: 'no refund id', body: { ...refundCompleted, id: undefined } },
    { name: 'no status', body: { ...refundCompleted, status: undefined } },
  ])('fails, naming the capture, when the response has $name', async ({ body }) => {
    stubFetch([{ method: 'POST', path: REFUND_PATH, status: 201, body }]);

    await expect(refundCapture(refundInput)).rejects.toThrow(CAPTURE_ID);
  });
});
