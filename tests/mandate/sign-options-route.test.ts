import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mandates/sign/options/route';
import { appDb } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { buyers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { mandateChallenge } from '@/lib/mandate/challenge';
import { confirmToken } from '@/lib/mandate/confirm-token';
import { renderReadback } from '@/lib/mandate/readback';
import { registerPasskey, registrationOptions } from '@/lib/passkeys/register';
import { readTicket } from '@/lib/passkeys/ticket';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { TestAuthenticator } from '@/tests/helpers/authenticator';
import { demoPolicy } from '@/tests/helpers/fixtures';
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
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';

async function request(body: unknown, { persona = 'buyer' }: { persona?: Persona | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' });
  if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/mandates/sign/options', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A request to sign `policy`, with the token a question-free compile of TEXT into it would have handed out. */
const signable = (policy: unknown = demoPolicy) => ({ text: TEXT, policy, confirmToken: confirmToken(TEXT, policy) });

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;
let buyerId: string;

/** Registers a software passkey for the demo buyer. */
async function registered(): Promise<TestAuthenticator> {
  const deps = { db, origin: APP_URL, now: () => new Date() };
  const authenticator = new TestAuthenticator(APP_URL);
  const { options, ticket } = await registrationOptions(deps, buyerId);
  await registerPasskey(deps, { buyerId, response: authenticator.register(options), ticket });
  return authenticator;
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-characters');
  vi.stubEnv('APP_URL', APP_URL);
  db = await createTestDb();
  vi.mocked(appDb).mockReturnValue(db);
  [{ id: buyerId }] = await db.insert(buyers).values({ name: DEMO_BUYER_NAME }).returning();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/mandates/sign/options', () => {
  it("asks the buyer's passkey to sign a challenge committing to the mandate, with a ticket for the confirm", async () => {
    const authenticator = await registered();

    const { status, body } = await answer(await POST(await request(signable())));

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    const claims = readTicket(body.ticket, 'mandate_sign', new Date());
    expect(claims).toMatchObject({ buyer: sha256Hex(buyerId) });
    expect(body.options).toMatchObject({
      rpId: 'behest.test',
      userVerification: 'preferred',
      allowCredentials: [{ id: authenticator.credentialId, type: 'public-key' }],
      challenge: mandateChallenge({
        policyHash: hashOf(demoPolicy),
        readbackHash: hashOf(renderReadback(demoPolicy)),
        nonce: claims!.nonce,
        exp: claims!.exp,
      }),
    });
  });

  it('answers 409 with a code the page can act on when the buyer has no passkey yet', async () => {
    expect(await answer(await POST(await request(signable())))).toEqual({
      status: 409,
      body: { error: { code: 'no_passkey', message: 'Register a passkey first.' } },
    });
  });

  it.each([
    ['no confirm token', () => ({ text: TEXT, policy: demoPolicy })],
    ['a token for other text', () => ({ ...signable(), text: `${TEXT}, and wine` })],
  ])('answers 409 to a request with %s, as the confirm would', async (_, body) => {
    await registered();

    expect(await answer(await POST(await request(body())))).toEqual({
      status: 409,
      body: { error: { message: 'answer the open questions first' } },
    });
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['no text', { policy: demoPolicy }],
    ['a policy that is not an object', { text: TEXT, policy: 'policy' }],
  ])('answers 400 to %s', async (_, body) => {
    expect(await answer(await POST(await request(body)))).toEqual({
      status: 400,
      body: { error: { message: 'Send the mandate text and the policy compiled from it.' } },
    });
  });

  it('answers 400 to a policy that is not valid', async () => {
    await registered();

    expect(await answer(await POST(await request(signable({ ...demoPolicy, currency: 'EUR' }))))).toEqual({
      status: 400,
      body: { error: { message: 'the mandate policy is not valid' } },
    });
  });

  it('refuses a body over 64 KiB with 413', async () => {
    expect(await answer(await POST(await request({ ...signable(), padding: 'a'.repeat(64 * 1024) })))).toEqual({
      status: 413,
      body: { error: { message: 'This request is too large.' } },
    });
  });

  it('counts requests per address and persona, and answers 429 past the limit', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await POST(await request(signable())))).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });
    expect(rateLimit).toHaveBeenCalledWith('mandate_sign_options:203.0.113.7:buyer', MODEL_ROUTE_LIMIT);
  });

  it.each([
    [null, 401],
    ['seller', 403],
  ] as const)('answers a request with persona %s with %i', async (persona, status) => {
    expect((await POST(await request(signable(), { persona }))).status).toBe(status);
    expect(rateLimit).not.toHaveBeenCalled();
  });
});
