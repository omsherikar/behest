import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mandates/confirm/route';
import { appDb, appPaypal, appSigner, demoBuyerId } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { buyers, mandates, wallets } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import type { MandatePolicy } from '@/lib/domain/policy';
import { MandatePayload } from '@/lib/domain/receipt';
import { confirmToken } from '@/lib/mandate/confirm-token';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner, verifyJws } from '@/lib/receipts/sign';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/app-deps')>();
  // demoBuyerId finds or creates the demo buyer for real unless a test says otherwise.
  return { ...actual, appDb: vi.fn(), appPaypal: vi.fn(), appSigner: vi.fn(), demoBuyerId: vi.fn(actual.demoBuyerId) };
});

const SECRET = 'test-session-secret-at-least-32-characters';
const APP_URL = 'https://behest.test';
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';
const APPROVE_URL = 'https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP-1';

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });

async function request(body: unknown, { persona = 'buyer' }: { persona?: Persona | 'forged' | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/mandates/confirm', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** A confirm of `policy` with the token a question-free compile of TEXT into it would have handed out. */
const confirmed = (policy: unknown = demoPolicy) => ({ text: TEXT, policy, confirmToken: confirmToken(TEXT, policy) });

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;
let paypal: FakePaypal;

/** Adds the demo buyer, as the seed does. */
async function addDemoBuyer(): Promise<string> {
  const [buyer] = await db.insert(buyers).values({ name: DEMO_BUYER_NAME }).returning();
  return buyer.id;
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', APP_URL);
  db = await createTestDb();
  paypal = new FakePaypal();
  vi.mocked(appDb).mockReturnValue(db);
  vi.mocked(appPaypal).mockReturnValue(paypal);
  vi.mocked(appSigner).mockResolvedValue(createSigner(key));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/mandates/confirm', () => {
  it('signs the mandate, keeps a pending wallet for the new setup token and returns the approve URL', async () => {
    const buyerId = await addDemoBuyer();

    const { status, body } = await answer(await POST(await request(confirmed())));

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    expect(body).toEqual({ mandateId: expect.any(String), approveUrl: APPROVE_URL });
    expect(paypal.callsTo('createSetupToken')).toEqual([
      [
        {
          returnUrl: 'https://behest.test/api/wallet/return',
          cancelUrl: 'https://behest.test/buyer?wallet=cancelled',
          description: 'Let your Behest agent pay within your mandate',
        },
      ],
    ]);

    const [mandate] = await db.select().from(mandates);
    expect(mandate).toMatchObject({ id: body.mandateId, buyerId, sourceText: TEXT, policy: demoPolicy, status: 'active' });
    const payload = await verifyJws(mandate.jws, 'behest-mandate+jws', publicJwks([key]), MandatePayload);
    expect(payload.id).toBe(body.mandateId);

    expect(await db.select().from(wallets)).toEqual([
      expect.objectContaining({
        buyerId,
        status: 'pending',
        setupTokenId: 'SETUP-1',
        paypalCustomerId: 'CUSTOMER-1',
        paymentTokenId: null,
        linkedAt: null,
      }),
    ]);
  });

  it('creates the demo buyer when there is none yet', async () => {
    const { status } = await answer(await POST(await request(confirmed())));

    expect(status).toBe(200);
    const [buyer] = await db.select().from(buyers);
    expect(buyer.name).toBe(DEMO_BUYER_NAME);
    expect(await db.select().from(wallets)).toEqual([expect.objectContaining({ buyerId: buyer.id, status: 'pending' })]);
  });

  it("replaces the buyer's linked wallet with a pending one for the new setup token", async () => {
    const buyerId = await addDemoBuyer();
    await db.insert(wallets).values({
      buyerId,
      status: 'linked',
      setupTokenId: 'SETUP-OLD',
      paypalCustomerId: 'CUSTOMER-OLD',
      paymentTokenId: 'TOKEN-OLD',
      linkedAt: new Date('2026-11-01T10:00:00Z'),
    });

    expect((await POST(await request(confirmed()))).status).toBe(200);

    expect(await db.select().from(wallets)).toEqual([
      expect.objectContaining({
        buyerId,
        status: 'pending',
        setupTokenId: 'SETUP-1',
        paypalCustomerId: 'CUSTOMER-1',
        paymentTokenId: null,
        linkedAt: null,
      }),
    ]);
  });

  const wider: MandatePolicy = { ...demoPolicy, budget: { amountCents: 600_000, period: 'month' }, perPurchaseMaxCents: 600_000 };

  // Bodies are built inside each test, once SESSION_SECRET is set for the token.
  it.each([
    ['no confirm token', () => ({ text: TEXT, policy: demoPolicy })],
    ['a token that is not the right one', () => ({ ...confirmed(), confirmToken: 'not-a-token' })],
    ['a token for other text', () => ({ ...confirmed(), text: `${TEXT}, and wine` })],
    ['a token for another policy', () => ({ ...confirmed(), policy: wider })],
  ])('answers 409 to a confirm with %s, signing nothing', async (_, body) => {
    await addDemoBuyer();

    expect(await answer(await POST(await request(body())))).toEqual({
      status: 409,
      body: { error: { message: 'answer the open questions first' } },
    });
    expect(await db.select().from(mandates)).toEqual([]);
    expect(await db.select().from(wallets)).toEqual([]);
    expect(paypal.calls).toEqual([]);
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['no text', { policy: demoPolicy, confirmToken: 'x' }],
    ['no policy', { text: TEXT, confirmToken: 'x' }],
    ['a policy that is not an object', { text: TEXT, policy: 'policy', confirmToken: 'x' }],
  ])('answers 400 to %s', async (_, body) => {
    expect(await answer(await POST(await request(body)))).toEqual({
      status: 400,
      body: { error: { message: 'Send the mandate text and the policy compiled from it.' } },
    });
    expect(paypal.calls).toEqual([]);
  });

  it.each([
    ['an invalid policy', { ...demoPolicy, currency: 'EUR' }, 400, 'the mandate policy is not valid'],
    ['a policy that has ended', { ...demoPolicy, expiresAt: '2020-01-01T00:00:00.000Z' }, 400, 'the mandate expiry is not after the time it is confirmed'],
  ])('answers %s with %i, storing nothing', async (_, policy, status, message) => {
    await addDemoBuyer();

    expect(await answer(await POST(await request(confirmed(policy))))).toEqual({ status, body: { error: { message } } });
    expect(await db.select().from(mandates)).toEqual([]);
    expect(await db.select().from(wallets)).toEqual([]);
    expect(paypal.calls).toEqual([]);
  });

  it('answers 404 when the buyer is gone by the time the mandate is signed', async () => {
    vi.mocked(demoBuyerId).mockResolvedValueOnce(crypto.randomUUID());

    expect(await answer(await POST(await request(confirmed())))).toEqual({
      status: 404,
      body: { error: { message: 'the mandate names a buyer that does not exist' } },
    });
    expect(paypal.calls).toEqual([]);
  });

  it('answers 502 without PayPal details when the setup token cannot be created, leaving the mandate signed', async () => {
    await addDemoBuyer();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('createSetupToken', 'network');

    expect(await answer(await POST(await request(confirmed())))).toEqual({
      status: 502,
      body: { error: { message: 'Your mandate is signed, but PayPal could not start linking your wallet. Confirm again to retry.' } },
    });
    expect(logged).toHaveBeenCalledWith('[mandates] PayPal could not start the wallet link:', expect.any(TypeError));
    expect(await db.select().from(mandates)).toHaveLength(1);
    expect(await db.select().from(wallets)).toEqual([]);
  });

  it.each([
    [undefined, 401],
    ['forged', 401],
    ['seller', 403],
    ['operator', 403],
  ] as const)('answers a request with persona %s with %i, signing nothing', async (persona, status) => {
    await addDemoBuyer();

    expect((await POST(await request(confirmed(), { persona: persona ?? null }))).status).toBe(status);
    expect(await db.select().from(mandates)).toEqual([]);
    expect(paypal.calls).toEqual([]);
  });
});
