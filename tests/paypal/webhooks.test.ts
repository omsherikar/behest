import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCalls, stubFetch } from '@/tests/helpers/paypal-fetch';
import verifySuccess from '@/tests/fixtures/paypal/webhook-verify-success.json';
import { resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { verifyWebhook } from '@/lib/paypal/webhooks';

const VERIFY = '/v1/notifications/verify-webhook-signature';
const WEBHOOK_ID = '4JH86294D6297924G';

const event = {
  id: 'WH-7YX49823S2290830K-0JE13296W68552352',
  event_version: '1.0',
  create_time: '2026-11-04T16:23:02.183Z',
  resource_type: 'dispute',
  event_type: 'CUSTOMER.DISPUTE.CREATED',
  summary: 'A new dispute opened with Case # PP-R-QXT-10071254',
  resource: {
    dispute_id: 'PP-R-QXT-10071254',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    dispute_amount: { currency_code: 'USD', value: '18.75' },
  },
};
const rawBody = JSON.stringify(event);

const signatureHeaders = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-7a8abba8',
  'paypal-transmission-id': '8e2c5a10-bb1f-11f1-a3d4-3b9e0c7f2a61',
  'paypal-transmission-sig': 'Hq3vZB2pXmY8kL1nR0sT4uW6yA9cE5gJ7iM2oQ4rS6tU8vX0zB3dF5hK7mN9pR1t==',
  'paypal-transmission-time': '2026-11-04T16:23:05Z',
};
type SignatureHeader = keyof typeof signatureHeaders;

/** The signature headers as PayPal sends them, with `name` removed. */
function headersWithout(name: SignatureHeader): Headers {
  const headers = new Headers(signatureHeaders);
  headers.delete(name);
  return headers;
}

beforeEach(() => {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('PAYPAL_WEBHOOK_ID', WEBHOOK_ID);
  resetPaypalTokenCacheForTests();
  setPaypalRetrySleepForTests(async () => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Everything verifyWebhook wrote with console.error, as one string. */
const errorLog = () => vi.mocked(console.error).mock.calls.flat().map(String).join('\n');

describe('verifyWebhook', () => {
  it('asks PayPal to check the signature headers against the webhook id and the event', async () => {
    const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

    await verifyWebhook(new Headers(signatureHeaders), rawBody);

    const [post] = apiCalls(calls);
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(JSON.parse(post.body ?? '')).toEqual({
      auth_algo: 'SHA256withRSA',
      cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-7a8abba8',
      transmission_id: '8e2c5a10-bb1f-11f1-a3d4-3b9e0c7f2a61',
      transmission_sig: 'Hq3vZB2pXmY8kL1nR0sT4uW6yA9cE5gJ7iM2oQ4rS6tU8vX0zB3dF5hK7mN9pR1t==',
      transmission_time: '2026-11-04T16:23:05Z',
      webhook_id: WEBHOOK_ID,
      webhook_event: event,
    });
  });

  it('accepts an event PayPal verifies, logging nothing', async () => {
    stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

    expect(await verifyWebhook(new Headers(signatureHeaders), rawBody)).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'FAILURE', body: { verification_status: 'FAILURE' } },
    { name: 'a lowercase success', body: { verification_status: 'success' } },
    { name: 'no verification status', body: {} },
  ])('rejects an event PayPal answers with $name', async ({ body }) => {
    stubFetch([{ method: 'POST', path: VERIFY, body }]);

    expect(await verifyWebhook(new Headers(signatureHeaders), rawBody)).toBe(false);
  });

  it.each(Object.keys(signatureHeaders) as SignatureHeader[])(
    'rejects an event with no %s header without asking PayPal',
    async (name) => {
      const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

      expect(await verifyWebhook(headersWithout(name), rawBody)).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it('rejects an event with an empty signature header without asking PayPal', async () => {
    const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

    const headers = new Headers({ ...signatureHeaders, 'paypal-transmission-sig': '' });

    expect(await verifyWebhook(headers, rawBody)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { name: 'unset', value: undefined },
    { name: 'empty', value: '' },
  ])('rejects every event without asking PayPal when PAYPAL_WEBHOOK_ID is $name', async ({ value }) => {
    vi.stubEnv('PAYPAL_WEBHOOK_ID', value);
    const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

    expect(await verifyWebhook(new Headers(signatureHeaders), rawBody)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it.each(['', 'not json', '{"id":"WH-7YX49823S2290830K', 'null', '[]', '42', '"event"'])(
    'rejects the body %j, which is not a JSON object, without asking PayPal',
    async (body) => {
      const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

      expect(await verifyWebhook(new Headers(signatureHeaders), body)).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    {
      status: 400,
      body: {
        name: 'VALIDATION_ERROR',
        message: 'Invalid request - see details',
        details: [{ field: 'webhook_id', location: 'body', issue: 'Webhook id is invalid' }],
        debug_id: '5c3e1a9b2d7f4',
      },
    },
    { status: 404, body: { name: 'INVALID_RESOURCE_ID', message: 'Requested resource ID was not found.' } },
    { status: 500, body: { name: 'INTERNAL_SERVICE_ERROR', message: 'An internal service error has occurred.' } },
    { status: 503, body: { name: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable.' } },
  ])('rejects the event, without throwing, when PayPal answers $status', async ({ status, body }) => {
    stubFetch([{ method: 'POST', path: VERIFY, status, body }]);

    await expect(verifyWebhook(new Headers(signatureHeaders), rawBody)).resolves.toBe(false);
  });

  it("logs PayPal's status and debug id when the verification call fails, and none of the event or its signature", async () => {
    const body = {
      name: 'AUTHENTICATION_FAILURE',
      message: 'Authentication failed due to invalid authentication credentials or a missing Authorization header.',
      debug_id: 'f81b2e3c9d4a7',
    };
    stubFetch([{ method: 'POST', path: VERIFY, status: 401, body }]);

    expect(await verifyWebhook(new Headers(signatureHeaders), rawBody)).toBe(false);

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(errorLog()).toContain('401');
    expect(errorLog()).toContain('f81b2e3c9d4a7');
    for (const secret of [
      ...Object.values(signatureHeaders),
      WEBHOOK_ID,
      event.id,
      'client-secret',
      'AUTHENTICATION_FAILURE',
    ]) {
      expect(errorLog()).not.toContain(secret);
    }
  });

  it('logs the status alone when the PayPal error body carries no debug id', async () => {
    stubFetch([{ method: 'POST', path: VERIFY, status: 500, body: { name: 'INTERNAL_SERVICE_ERROR' } }]);

    expect(await verifyWebhook(new Headers(signatureHeaders), rawBody)).toBe(false);

    expect(errorLog()).toContain('500');
    expect(errorLog()).not.toContain('debug');
  });

  it('rejects the event, without throwing, when PayPal cannot be reached, logging the error name and message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(verifyWebhook(new Headers(signatureHeaders), rawBody)).resolves.toBe(false);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(errorLog()).toContain('TypeError');
    expect(errorLog()).toContain('fetch failed');
  });

  it('rejects the event, without throwing, when the PayPal credentials are missing', async () => {
    vi.stubEnv('PAYPAL_CLIENT_SECRET', undefined);
    const calls = stubFetch([{ method: 'POST', path: VERIFY, body: verifySuccess }]);

    await expect(verifyWebhook(new Headers(signatureHeaders), rawBody)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
