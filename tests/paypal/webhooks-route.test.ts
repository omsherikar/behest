import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/paypal/webhooks/route';
import { appDb, appPaypal } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { jobs, webhookEvents } from '@/lib/db/schema';
import { PUBLIC_WRITE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
  appPaypal: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

/** A PayPal event as PayPal sends it, with a private detail that must never reach a log. */
const EVENT = {
  id: 'WH-58D329510W468432D-8HN650336L201105X',
  event_version: '1.0',
  create_time: '2026-11-06T12:00:00.000Z',
  resource_type: 'checkout-order',
  event_type: 'CHECKOUT.ORDER.APPROVED',
  summary: 'An order has been approved by buyer',
  resource: { id: 'ORDER-1', status: 'APPROVED', payer: { email_address: 'priya@example.com' } },
};

const SIGNATURE = {
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
  'paypal-transmission-id': 'TRANSMISSION-1',
  'paypal-transmission-sig': 'c2lnbmF0dXJl',
  'paypal-transmission-time': '2026-11-06T12:00:01Z',
};

/** PayPal delivering `body`, exactly as given, with its signature headers. */
function deliver(body: unknown = EVENT) {
  return POST(
    new NextRequest('http://localhost/api/paypal/webhooks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '173.0.82.126', ...SIGNATURE },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

async function stored(db: Db) {
  return {
    events: await db.select().from(webhookEvents),
    jobs: await db.select({ kind: jobs.kind, payload: jobs.payload, status: jobs.status }).from(jobs),
  };
}

const NOTHING = { events: [], jobs: [] };
const NOT_VERIFIED = { error: { message: 'The event could not be verified as coming from PayPal.' } };

let db: Db;
let paypal: FakePaypal;

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  vi.stubEnv('PAYPAL_WEBHOOK_ID', 'WEBHOOK-1');
  db = await createTestDb();
  paypal = new FakePaypal();
  vi.mocked(appDb).mockReturnValue(db);
  vi.mocked(appPaypal).mockReturnValue(paypal);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/paypal/webhooks', () => {
  it('verifies the raw body with PayPal, stores the event and queues its webhook job', async () => {
    const raw = JSON.stringify(EVENT, null, 2);

    expect(await answer(await deliver(raw))).toEqual({ status: 200, body: { received: true } });

    expect(connection).toHaveBeenCalled();
    const [[headers, body]] = paypal.callsTo('verifyWebhook');
    expect(body).toBe(raw);
    expect(Object.fromEntries(Object.keys(SIGNATURE).map((name) => [name, headers.get(name)]))).toEqual(SIGNATURE);
    const { events, jobs: queued } = await stored(db);
    expect(events).toEqual([
      expect.objectContaining({ eventId: EVENT.id, eventType: 'CHECKOUT.ORDER.APPROVED', payload: EVENT, processedAt: null }),
    ]);
    expect(queued).toEqual([{ kind: 'webhook', payload: { eventId: EVENT.id }, status: 'queued' }]);
  });

  it('answers 200 to an event id it has already stored, without storing or queuing it again', async () => {
    await deliver();

    expect(await answer(await deliver({ ...EVENT, summary: 'Delivered again' }))).toEqual({ status: 200, body: { received: true } });

    const { events, jobs: queued } = await stored(db);
    expect(events).toEqual([expect.objectContaining({ eventId: EVENT.id, payload: EVENT })]);
    expect(queued).toHaveLength(1);
  });

  it('answers 400 to an event PayPal does not verify, storing nothing and logging only why', async () => {
    paypal.webhookValid = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await answer(await deliver())).toEqual({ status: 400, body: NOT_VERIFIED });

    expect(await stored(db)).toEqual(NOTHING);
    expect(warn.mock.calls).toEqual([['Rejected a PayPal webhook (unverified)']]);
  });

  it('fails closed with 400 when PAYPAL_WEBHOOK_ID is not set, logging the configuration error', async () => {
    vi.stubEnv('PAYPAL_WEBHOOK_ID', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await answer(await deliver())).toEqual({ status: 400, body: NOT_VERIFIED });

    expect(paypal.calls).toEqual([]);
    expect(await stored(db)).toEqual(NOTHING);
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0][0])).toContain('PAYPAL_WEBHOOK_ID is not set');
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['an event with no id', { ...EVENT, id: undefined }],
    ['an event with no event type', { ...EVENT, event_type: '' }],
    ['a body that is not an object', '[]'],
  ])('answers 400 to %s, storing nothing', async (_, body) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await deliver(body)).status).toBe(400);

    expect(await stored(db)).toEqual(NOTHING);
    expect(warn.mock.calls).toEqual([['Rejected a PayPal webhook (malformed)']]);
  });

  it('refuses a body over 256 KiB with 413 before asking PayPal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await deliver({ ...EVENT, summary: 'a'.repeat(256 * 1024) });

    expect(await answer(response)).toEqual({ status: 413, body: { error: { message: 'This request is too large.' } } });
    expect(paypal.calls).toEqual([]);
    expect(await stored(db)).toEqual(NOTHING);
    expect(warn.mock.calls).toEqual([['Rejected a PayPal webhook (too_large)']]);
  });

  it('counts deliveries per address against the public write limit, and answers 429 past it before verifying', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await deliver())).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });

    expect(rateLimit).toHaveBeenCalledWith('paypal_webhooks:173.0.82.126', PUBLIC_WRITE_LIMIT);
    expect(paypal.calls).toEqual([]);
    expect(await stored(db)).toEqual(NOTHING);
  });
});
