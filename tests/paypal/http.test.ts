import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, type FakeRoute, type RecordedCall } from '@/tests/helpers/fake-fetch';
import {
  PayPalApiError,
  paypalRequest,
  resetPaypalTokenCacheForTests,
  setPaypalRetrySleepForTests,
} from '@/lib/paypal/http';

const TOKEN_PATH = '/v1/oauth2/token';

const token = (accessToken: string, expiresIn = 32_400): FakeRoute => ({
  method: 'POST',
  path: TOKEN_PATH,
  body: { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn },
  once: true,
});

const unavailable = (method: string, path: string): FakeRoute => ({
  method,
  path,
  status: 503,
  body: { name: 'SERVICE_UNAVAILABLE' },
  once: true,
});

let sleeps: number[];

function stubFetch(routes: FakeRoute[]): RecordedCall[] {
  const f = fakeFetch(routes);
  vi.stubGlobal('fetch', f.fetch);
  return f.calls;
}

const pathOf = (call: RecordedCall) => new URL(call.url).pathname;
const tokenCalls = (calls: RecordedCall[]) => calls.filter((c) => pathOf(c) === TOKEN_PATH);
const apiCalls = (calls: RecordedCall[]) => calls.filter((c) => pathOf(c) !== TOKEN_PATH);

beforeEach(() => {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  resetPaypalTokenCacheForTests();
  sleeps = [];
  setPaypalRetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('access token', () => {
  it('fetches the token once for two calls', async () => {
    const calls = stubFetch([token('T1'), { method: 'GET', path: '/v1/things', body: { n: 1 } }]);

    expect(await paypalRequest('GET', '/v1/things')).toEqual({ n: 1 });
    expect(await paypalRequest('GET', '/v1/things')).toEqual({ n: 1 });

    expect(tokenCalls(calls)).toHaveLength(1);
    expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect(calls[0].body).toBe('grant_type=client_credentials');
    expect(apiCalls(calls).map((c) => c.headers.authorization)).toEqual(['Bearer T1', 'Bearer T1']);
  });

  it('fetches a new token once the cached one is within 60 seconds of expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const calls = stubFetch([token('T1', 3600), token('T2', 3600), { method: 'GET', path: '/v1/things', body: {} }]);

    await paypalRequest('GET', '/v1/things');
    vi.setSystemTime(new Date('2026-01-01T00:58:59Z'));
    await paypalRequest('GET', '/v1/things');
    vi.setSystemTime(new Date('2026-01-01T00:59:01Z'));
    await paypalRequest('GET', '/v1/things');

    expect(apiCalls(calls).map((c) => c.headers.authorization)).toEqual(['Bearer T1', 'Bearer T1', 'Bearer T2']);
  });

  it('refreshes the token after a 401 and retries', async () => {
    const calls = stubFetch([
      token('T1'),
      token('T2'),
      { method: 'GET', path: '/v1/things', status: 401, body: { error: 'invalid_token' }, once: true },
      { method: 'GET', path: '/v1/things', body: { ok: true } },
    ]);

    expect(await paypalRequest('GET', '/v1/things')).toEqual({ ok: true });
    expect(await paypalRequest('GET', '/v1/things')).toEqual({ ok: true });

    expect(apiCalls(calls).map((c) => c.headers.authorization)).toEqual(['Bearer T1', 'Bearer T2', 'Bearer T2']);
    expect(sleeps).toEqual([]);
  });

  it('refreshes the token only once', async () => {
    const calls = stubFetch([
      token('T1'),
      token('T2'),
      { method: 'GET', path: '/v1/things', status: 401, body: { error: 'invalid_token' } },
    ]);

    await expect(paypalRequest('GET', '/v1/things')).rejects.toMatchObject({ status: 401, path: '/v1/things' });
    expect(tokenCalls(calls)).toHaveLength(2);
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it('refreshes the token after a 401 on a POST without a request id', async () => {
    const calls = stubFetch([
      token('T1'),
      token('T2'),
      { method: 'POST', path: '/v1/things', status: 401, body: { error: 'invalid_token' }, once: true },
      { method: 'POST', path: '/v1/things', body: { ok: true } },
    ]);

    expect(await paypalRequest('POST', '/v1/things', { body: { a: 1 } })).toEqual({ ok: true });
    expect(apiCalls(calls).map((c) => c.headers.authorization)).toEqual(['Bearer T1', 'Bearer T2']);
  });

  it('requires the client id and secret', async () => {
    vi.stubEnv('PAYPAL_CLIENT_SECRET', undefined);
    const calls = stubFetch([token('T1')]);

    await expect(paypalRequest('GET', '/v1/things')).rejects.toThrow(/PAYPAL_CLIENT_SECRET/);
    expect(calls).toHaveLength(0);
  });
});

describe('retries', () => {
  it.each([429, 500, 503])('retries a GET after a %i', async (status) => {
    const calls = stubFetch([
      token('T1'),
      { method: 'GET', path: '/v1/things', status, body: { name: 'ERROR' }, once: true },
      { method: 'GET', path: '/v1/things', body: { ok: true } },
    ]);

    expect(await paypalRequest('GET', '/v1/things')).toEqual({ ok: true });
    expect(apiCalls(calls)).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it('does not retry a POST without a request id after a 503', async () => {
    const calls = stubFetch([
      token('T1'),
      unavailable('POST', '/v2/checkout/orders'),
      { method: 'POST', path: '/v2/checkout/orders', body: { id: 'O1' } },
    ]);

    const error = await paypalRequest('POST', '/v2/checkout/orders', { body: { intent: 'CAPTURE' } }).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 503, path: '/v2/checkout/orders' });
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('retries a POST with a request id, sending the same PayPal-Request-Id each time', async () => {
    const calls = stubFetch([
      token('T1'),
      unavailable('POST', '/v2/checkout/orders'),
      { method: 'POST', path: '/v2/checkout/orders', body: { id: 'O1' } },
    ]);

    const order = await paypalRequest('POST', '/v2/checkout/orders', {
      body: { intent: 'CAPTURE' },
      requestId: 'purchase-1:charge',
    });

    expect(order).toEqual({ id: 'O1' });
    const posts = apiCalls(calls);
    expect(posts.map((c) => c.headers['paypal-request-id'])).toEqual(['purchase-1:charge', 'purchase-1:charge']);
    expect(posts[1].body).toBe(posts[0].body);
  });

  it('gives up after four attempts, backing off exponentially', async () => {
    const calls = stubFetch([
      token('T1'),
      { method: 'GET', path: '/v1/things', status: 503, body: { name: 'SERVICE_UNAVAILABLE' } },
    ]);

    await expect(paypalRequest('GET', '/v1/things')).rejects.toMatchObject({ status: 503 });
    expect(apiCalls(calls)).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('does not retry a client error, even with a request id', async () => {
    const calls = stubFetch([
      token('T1'),
      { method: 'POST', path: '/v2/checkout/orders', status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } },
    ]);

    const error = await paypalRequest('POST', '/v2/checkout/orders', { body: {}, requestId: 'purchase-1:charge' }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 422, message: expect.stringContaining('UNPROCESSABLE_ENTITY') });
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('keeps the whole response body on the error, though the message is cut short', async () => {
    const body = {
      name: 'UNPROCESSABLE_ENTITY',
      message: 'The requested action could not be performed, semantically incorrect, or failed business validation.',
      details: [{ issue: 'INSTRUMENT_DECLINED', description: 'x'.repeat(400) }],
    };
    stubFetch([token('T1'), { method: 'POST', path: '/v2/checkout/orders', status: 422, body }]);

    const error = await paypalRequest<never>('POST', '/v2/checkout/orders', { body: {} }).catch((e: PayPalApiError) => e);

    expect(error.body).toBe(JSON.stringify(body));
    expect(error.message.length).toBeLessThan(error.body.length);
  });
});

describe('requests', () => {
  it('sends a JSON body with the caller headers and no request id unless given', async () => {
    const calls = stubFetch([token('T1'), { method: 'POST', path: '/v1/things', status: 201, body: { id: 'X1' } }]);

    const created = await paypalRequest('POST', '/v1/things', {
      body: { name: 'thing' },
      headers: { Prefer: 'return=representation' },
    });

    expect(created).toEqual({ id: 'X1' });
    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v1/things');
    expect(post.headers['content-type']).toBe('application/json');
    expect(post.headers.prefer).toBe('return=representation');
    expect(post.headers['paypal-request-id']).toBeUndefined();
    expect(JSON.parse(post.body ?? '')).toEqual({ name: 'thing' });
  });

  it('sends a form as multipart', async () => {
    const calls = stubFetch([
      token('T1'),
      { method: 'POST', path: '/v1/customer/disputes/D1/provide-evidence', body: { links: [] } },
    ]);
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences: [] })], { type: 'application/json' }));

    await paypalRequest('POST', '/v1/customer/disputes/D1/provide-evidence', { form });

    const [post] = apiCalls(calls);
    expect(post.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(post.body).toContain('name="input"');
    expect(post.body).toContain('{"evidences":[]}');
  });

  it('returns undefined for a response with no content', async () => {
    stubFetch([token('T1'), { method: 'PATCH', path: '/v2/checkout/orders/O1', status: 204, body: null }]);

    const result = await paypalRequest('PATCH', '/v2/checkout/orders/O1', { body: [{ op: 'replace' }] });

    expect(result).toBeUndefined();
  });
});
