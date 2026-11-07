import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as options } from '@/app/api/passkeys/register/options/route';
import { POST as verify } from '@/app/api/passkeys/register/verify/route';
import { appDb } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { buyerPasskeys, buyers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { TestAuthenticator } from '@/tests/helpers/authenticator';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

const APP_URL = 'https://behest.test';

async function request(path: string, body?: unknown, { persona = 'buyer' }: { persona?: Persona | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' });
  if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest(`http://localhost/api/passkeys/register/${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-characters');
  vi.stubEnv('APP_URL', APP_URL);
  db = await createTestDb();
  vi.mocked(appDb).mockReturnValue(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/passkeys/register/options and /verify', () => {
  it("registers a passkey for the buyer persona's buyer, created when there is none yet", async () => {
    const authenticator = new TestAuthenticator(APP_URL);

    const started = await answer(await options(await request('options')));
    expect(started).toEqual({ status: 200, body: { options: expect.any(Object), ticket: expect.any(String) } });
    expect(started.body.options).toMatchObject({ rp: { name: 'Behest', id: 'behest.test' }, user: { name: DEMO_BUYER_NAME } });
    expect(connection).toHaveBeenCalled();

    const response = authenticator.register(started.body.options);
    const finished = await answer(await verify(await request('verify', { response, ticket: started.body.ticket })));

    expect(finished).toEqual({ status: 200, body: { credentialId: authenticator.credentialId } });
    const [buyer] = await db.select().from(buyers);
    expect(buyer.name).toBe(DEMO_BUYER_NAME);
    expect(await db.select().from(buyerPasskeys)).toEqual([
      expect.objectContaining({ buyerId: buyer.id, credentialId: authenticator.credentialId }),
    ]);
  });

  it('answers 400 with a fixed message to a registration that does not verify, storing nothing', async () => {
    const authenticator = new TestAuthenticator('https://behest.example');
    const started = await answer(await options(await request('options')));
    const response = authenticator.register(started.body.options);

    expect(await answer(await verify(await request('verify', { response, ticket: started.body.ticket })))).toEqual({
      status: 400,
      body: { error: { message: 'Your passkey could not be registered. Try again.' } },
    });
    expect(await db.select().from(buyerPasskeys)).toEqual([]);
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['a body that is not an object', '[]'],
  ])('answers 400 to %s', async (_, body) => {
    expect(await answer(await verify(await request('verify', body)))).toEqual({
      status: 400,
      body: { error: { message: 'Send the passkey and the ticket it answers.' } },
    });
  });

  it('refuses a body over 64 KiB with 413', async () => {
    expect(await answer(await verify(await request('verify', { padding: 'a'.repeat(64 * 1024) })))).toEqual({
      status: 413,
      body: { error: { message: 'This request is too large.' } },
    });
  });

  it.each([
    ['options', options, 'passkey_register_options'],
    ['verify', verify, 'passkey_register_verify'],
  ] as const)('counts %s requests per address and persona, and answers 429 past the limit', async (path, route, key) => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await route(await request(path, {})))).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });
    expect(rateLimit).toHaveBeenCalledWith(`${key}:203.0.113.7:buyer`, MODEL_ROUTE_LIMIT);
  });

  it.each([
    [null, 401],
    ['seller', 403],
    ['operator', 403],
  ] as const)('answers a request with persona %s with %i', async (persona, status) => {
    for (const [path, route] of [
      ['options', options],
      ['verify', verify],
    ] as const) {
      expect((await route(await request(path, {}, { persona }))).status).toBe(status);
    }
    expect(rateLimit).not.toHaveBeenCalled();
    expect(await db.select().from(buyers)).toEqual([]);
  });
});
