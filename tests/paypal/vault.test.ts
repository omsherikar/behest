import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeRoute } from '@/tests/helpers/fake-fetch';
import { apiCalls, stubFetch } from '@/tests/helpers/paypal-fetch';
import paymentToken from '@/tests/fixtures/paypal/payment-token.json';
import setupToken from '@/tests/fixtures/paypal/setup-token.json';
import { resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { createPaymentToken, createSetupToken } from '@/lib/paypal/vault';

const SETUP_TOKENS = '/v3/vault/setup-tokens';
const PAYMENT_TOKENS = '/v3/vault/payment-tokens';

const unavailable = (path: string): FakeRoute => ({
  method: 'POST',
  path,
  status: 503,
  body: { name: 'SERVICE_UNAVAILABLE' },
  once: true,
});

const setupInput = {
  returnUrl: 'https://behest.test/mandate/approved',
  cancelUrl: 'https://behest.test/mandate/cancelled',
  description: 'Let my shopping agent pay within my mandate',
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

describe('createSetupToken', () => {
  it('asks PayPal to save the wallet with no purchase', async () => {
    const calls = stubFetch([{ method: 'POST', path: SETUP_TOKENS, body: setupToken }]);

    await createSetupToken(setupInput);

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v3/vault/setup-tokens');
    expect(JSON.parse(post.body ?? '')).toEqual({
      payment_source: {
        paypal: {
          description: 'Let my shopping agent pay within my mandate',
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: false,
          experience_context: {
            return_url: 'https://behest.test/mandate/approved',
            cancel_url: 'https://behest.test/mandate/cancelled',
            brand_name: 'Behest',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    });
  });

  it('returns the setup token id, approve link and customer id', async () => {
    stubFetch([{ method: 'POST', path: SETUP_TOKENS, body: setupToken }]);

    expect(await createSetupToken(setupInput)).toEqual({
      id: '4SR36794JN117492X',
      approveUrl: 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=4SR36794JN117492X',
      customerId: 'customer_2471939104',
    });
  });

  it('accepts a payer-action link as the approve link', async () => {
    const links = setupToken.links.map((link) =>
      link.rel === 'approve' ? { ...link, rel: 'payer-action', href: 'https://www.sandbox.paypal.com/payer-action/4SR36794JN117492X' } : link,
    );
    stubFetch([{ method: 'POST', path: SETUP_TOKENS, body: { ...setupToken, links } }]);

    const created = await createSetupToken(setupInput);

    expect(created.approveUrl).toBe('https://www.sandbox.paypal.com/payer-action/4SR36794JN117492X');
  });

  it('fails, naming the setup token, when PayPal sends no approve link', async () => {
    const links = setupToken.links.filter((link) => link.rel !== 'approve');
    stubFetch([{ method: 'POST', path: SETUP_TOKENS, body: { ...setupToken, links } }]);

    await expect(createSetupToken(setupInput)).rejects.toThrow(/4SR36794JN117492X/);
  });

  it('sends a fresh PayPal-Request-Id on each call', async () => {
    const calls = stubFetch([{ method: 'POST', path: SETUP_TOKENS, body: setupToken }]);

    await createSetupToken(setupInput);
    await createSetupToken(setupInput);

    const ids = apiCalls(calls).map((c) => c.headers['paypal-request-id']);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('retries after a 503 with the same PayPal-Request-Id', async () => {
    const calls = stubFetch([unavailable(SETUP_TOKENS), { method: 'POST', path: SETUP_TOKENS, body: setupToken }]);

    expect((await createSetupToken(setupInput)).id).toBe('4SR36794JN117492X');

    const ids = apiCalls(calls).map((c) => c.headers['paypal-request-id']);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });
});

describe('createPaymentToken', () => {
  it('exchanges the approved setup token for a payment token', async () => {
    const calls = stubFetch([{ method: 'POST', path: PAYMENT_TOKENS, body: paymentToken }]);

    expect(await createPaymentToken('4SR36794JN117492X')).toEqual({
      id: '7wy41927ts038352h',
      customerId: 'customer_2471939104',
    });

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v3/vault/payment-tokens');
    expect(JSON.parse(post.body ?? '')).toEqual({
      payment_source: { token: { id: '4SR36794JN117492X', type: 'SETUP_TOKEN' } },
    });
  });

  it('keys the request on the setup token, so a retried exchange creates one payment token', async () => {
    const calls = stubFetch([unavailable(PAYMENT_TOKENS), { method: 'POST', path: PAYMENT_TOKENS, body: paymentToken }]);

    expect((await createPaymentToken('4SR36794JN117492X')).id).toBe('7wy41927ts038352h');

    expect(apiCalls(calls).map((c) => c.headers['paypal-request-id'])).toEqual([
      '4SR36794JN117492X:payment-token',
      '4SR36794JN117492X:payment-token',
    ]);
  });
});
