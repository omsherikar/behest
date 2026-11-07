import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { registerWebhook, WEBHOOK_EVENT_TYPES, webhookUrl } from '@/lib/paypal/webhook-registration';
import { apiCalls, stubFetch } from '@/tests/helpers/paypal-fetch';

const WEBHOOKS = '/v1/notifications/webhooks';
const URL_FOR_APP = 'https://behest.example.com/api/paypal/webhooks';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const eventTypes = [
  { name: 'CHECKOUT.ORDER.APPROVED' },
  { name: 'PAYMENT.CAPTURE.COMPLETED' },
  { name: 'PAYMENT.CAPTURE.DENIED' },
  { name: 'PAYMENT.CAPTURE.REFUNDED' },
  { name: 'PAYMENT.CAPTURE.REVERSED' },
  { name: 'CUSTOMER.DISPUTE.CREATED' },
  { name: 'CUSTOMER.DISPUTE.UPDATED' },
  { name: 'CUSTOMER.DISPUTE.RESOLVED' },
  { name: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' },
  { name: 'PAYMENT.PAYOUTS-ITEM.FAILED' },
];

/** A webhook as PayPal lists it. */
const listed = (id: string, url: string) => ({
  id,
  url,
  event_types: [{ name: 'CHECKOUT.ORDER.APPROVED', description: 'An order has been approved by buyer.' }],
  links: [{ href: `https://api-m.sandbox.paypal.com${WEBHOOKS}/${id}`, rel: 'self', method: 'GET' }],
});

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

describe('webhook URL', () => {
  it('is the webhook route under an https origin', () => {
    expect(webhookUrl('https://behest.example.com')).toBe(URL_FOR_APP);
    expect(webhookUrl('https://behest.example.com:8443')).toBe('https://behest.example.com:8443/api/paypal/webhooks');
  });

  it.each(['http://behest.example.com', 'http://localhost:3000', 'ftp://behest.example.com', 'behest.example.com', ''])(
    'refuses %j, since PayPal delivers webhooks over https only',
    (origin) => {
      expect(() => webhookUrl(origin)).toThrow('APP_URL must be an https origin');
    },
  );
});

describe('registering the webhook', () => {
  it('lists the ten event types Behest acts on, the reversal and the dispute outcome included', () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual(eventTypes.map(({ name }) => name));
  });

  it('creates a webhook for the URL with every event type when there is none', async () => {
    const calls = stubFetch([
      { method: 'GET', path: WEBHOOKS, body: { webhooks: [listed('8PT597110X687430LKGECATA', 'https://other.example.com/hooks')] } },
      { method: 'POST', path: WEBHOOKS, status: 201, body: { id: '0EH40505U7160970P', url: URL_FOR_APP, event_types: eventTypes } },
    ]);

    await expect(registerWebhook(URL_FOR_APP)).resolves.toEqual({ id: '0EH40505U7160970P', created: true });

    const [list, create] = apiCalls(calls);
    expect(apiCalls(calls)).toHaveLength(2);
    expect([list.method, list.url]).toEqual(['GET', `https://api-m.sandbox.paypal.com${WEBHOOKS}`]);
    expect([create.method, create.url]).toEqual(['POST', `https://api-m.sandbox.paypal.com${WEBHOOKS}`]);
    expect(JSON.parse(create.body ?? '')).toEqual({ url: URL_FOR_APP, event_types: eventTypes });
    expect(create.headers['paypal-request-id']).toMatch(UUID);
    expect(create.headers.authorization).toBe('Bearer T1');
  });

  it('creates one when PayPal lists no webhooks at all', async () => {
    const calls = stubFetch([
      { method: 'GET', path: WEBHOOKS, body: {} },
      { method: 'POST', path: WEBHOOKS, status: 201, body: { id: '0EH40505U7160970P', url: URL_FOR_APP, event_types: eventTypes } },
    ]);

    await expect(registerWebhook(URL_FOR_APP)).resolves.toEqual({ id: '0EH40505U7160970P', created: true });
    expect(apiCalls(calls).map((call) => call.method)).toEqual(['GET', 'POST']);
  });

  it('gives the existing webhook for the URL every event type instead of creating a second', async () => {
    const calls = stubFetch([
      {
        method: 'GET',
        path: WEBHOOKS,
        body: { webhooks: [listed('8PT597110X687430LKGECATA', 'https://other.example.com/hooks'), listed('5GP028458E2496506', URL_FOR_APP)] },
      },
      { method: 'PATCH', path: `${WEBHOOKS}/5GP028458E2496506`, body: { id: '5GP028458E2496506', url: URL_FOR_APP, event_types: eventTypes } },
    ]);

    await expect(registerWebhook(URL_FOR_APP)).resolves.toEqual({ id: '5GP028458E2496506', created: false });

    const [, update] = apiCalls(calls);
    expect(apiCalls(calls).map((call) => call.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(update.body ?? '')).toEqual([{ op: 'replace', path: '/event_types', value: eventTypes }]);
    expect(update.headers['paypal-request-id']).toMatch(UUID);
  });
});
