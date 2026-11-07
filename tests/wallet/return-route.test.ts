import { eq } from 'drizzle-orm';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/wallet/return/route';
import { appDb, appPaypal } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { buyers, wallets } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
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

const SECRET = 'test-session-secret-at-least-32-characters';
const LINKED = 'https://behest.test/buyer?wallet=linked';
const ERROR = 'https://behest.test/buyer?wallet=error';

/** PayPal's return, carrying a token id of an attacker's choosing in the query. */
async function paypalReturn({ persona = 'buyer' }: { persona?: Persona | 'forged' | null } = {}) {
  const headers = new Headers();
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/wallet/return?approval_token_id=SETUP-FROM-QUERY&approval_session_id=S1', {
    headers,
  });
}

let db: Db;
let paypal: FakePaypal;

async function addBuyer(name: string): Promise<string> {
  const [buyer] = await db.insert(buyers).values({ name }).returning();
  return buyer.id;
}

const walletOf = async (buyerId: string) => (await db.select().from(wallets).where(eq(wallets.buyerId, buyerId)))[0];

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', 'https://behest.test');
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

describe('GET /api/wallet/return', () => {
  it("links the buyer's pending wallet with the setup token kept on it, never the one in the query", async () => {
    const buyerId = await addBuyer(DEMO_BUYER_NAME);
    await db.insert(wallets).values({ buyerId, status: 'pending', setupTokenId: 'SETUP-7', paypalCustomerId: 'CUSTOMER-1' });

    const response = await GET(await paypalReturn());

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(LINKED);
    expect(connection).toHaveBeenCalled();
    expect(paypal.callsTo('createPaymentToken')).toEqual([['SETUP-7']]);
    expect(await walletOf(buyerId)).toMatchObject({
      status: 'linked',
      setupTokenId: 'SETUP-7',
      paymentTokenId: 'TOKEN-1',
      paypalCustomerId: 'CUSTOMER-1',
      linkedAt: expect.any(Date),
    });
  });

  it('sends the buyer to the error notice when they have no wallet', async () => {
    await addBuyer(DEMO_BUYER_NAME);

    const response = await GET(await paypalReturn());

    expect(response.headers.get('location')).toBe(ERROR);
    expect(paypal.calls).toEqual([]);
  });

  it('never links the pending wallet of another buyer', async () => {
    await addBuyer(DEMO_BUYER_NAME);
    const otherId = await addBuyer('Arjun');
    await db.insert(wallets).values({ buyerId: otherId, status: 'pending', setupTokenId: 'SETUP-ARJUN' });

    const response = await GET(await paypalReturn());

    expect(response.headers.get('location')).toBe(ERROR);
    expect(paypal.calls).toEqual([]);
    expect(await walletOf(otherId)).toMatchObject({ status: 'pending', paymentTokenId: null });
  });

  it('sends the buyer to the error notice when the wallet is already linked, leaving it as it was', async () => {
    const buyerId = await addBuyer(DEMO_BUYER_NAME);
    const linkedAt = new Date('2026-11-01T10:00:00Z');
    await db.insert(wallets).values({ buyerId, status: 'linked', setupTokenId: 'SETUP-7', paymentTokenId: 'TOKEN-7', linkedAt });

    const response = await GET(await paypalReturn());

    expect(response.headers.get('location')).toBe(ERROR);
    expect(paypal.calls).toEqual([]);
    expect(await walletOf(buyerId)).toMatchObject({ status: 'linked', paymentTokenId: 'TOKEN-7', linkedAt });
  });

  it('sends the buyer to the error notice and keeps the wallet pending when PayPal cannot save it', async () => {
    const buyerId = await addBuyer(DEMO_BUYER_NAME);
    await db.insert(wallets).values({ buyerId, status: 'pending', setupTokenId: 'SETUP-7' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('createPaymentToken', 'network');

    const response = await GET(await paypalReturn());

    expect(response.headers.get('location')).toBe(ERROR);
    expect(logged).toHaveBeenCalledWith('[wallet] PayPal could not save the wallet:', expect.any(TypeError));
    expect(await walletOf(buyerId)).toMatchObject({ status: 'pending', paymentTokenId: null });
  });

  it('leaves a wallet that a newer confirm replaced while PayPal answered as the newer confirm set it', async () => {
    const buyerId = await addBuyer(DEMO_BUYER_NAME);
    await db.insert(wallets).values({ buyerId, status: 'pending', setupTokenId: 'SETUP-7' });
    const exchange = paypal.createPaymentToken.bind(paypal);
    vi.spyOn(paypal, 'createPaymentToken').mockImplementation(async (setupTokenId) => {
      await db.update(wallets).set({ setupTokenId: 'SETUP-8' }).where(eq(wallets.buyerId, buyerId));
      return exchange(setupTokenId);
    });

    const response = await GET(await paypalReturn());

    expect(response.headers.get('location')).toBe(ERROR);
    expect(await walletOf(buyerId)).toMatchObject({ status: 'pending', setupTokenId: 'SETUP-8', paymentTokenId: null });
  });

  it.each([
    [undefined, 401],
    ['forged', 401],
    ['seller', 403],
    ['operator', 403],
  ] as const)('answers a request with persona %s with %i, linking nothing', async (persona, status) => {
    const buyerId = await addBuyer(DEMO_BUYER_NAME);
    await db.insert(wallets).values({ buyerId, status: 'pending', setupTokenId: 'SETUP-7' });

    expect((await GET(await paypalReturn({ persona: persona ?? null }))).status).toBe(status);
    expect(paypal.calls).toEqual([]);
    expect(await walletOf(buyerId)).toMatchObject({ status: 'pending' });
  });
});
