import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/demo/reset/route';
import { appDb } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { seedDemo } from '@/lib/demo/seed';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { addDemoActivity, rowCounts } from '@/tests/helpers/demo-activity';
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

const SECRET = 'test-session-secret-at-least-32-characters';
const PAYEE = 'payee@business.example.com';
const CONFIRM = 'Send {"confirm":"reset"} to reset the demo, with "full":true to remove the linked wallet too.';

async function request(body: unknown, { persona = 'operator' }: { persona?: Persona | 'forged' | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/demo/reset', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('PAYEE_EMAIL', PAYEE);
  db = await createTestDb();
  vi.mocked(appDb).mockReturnValue(db);
  await seedDemo(db, { payeeEmail: PAYEE });
  await addDemoActivity(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/demo/reset', () => {
  it('resets the demo and answers 200 with what it removed and seeded, keeping the linked wallet', async () => {
    const { status, body } = await answer(await POST(await request({ confirm: 'reset' })));

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    expect(body).toEqual({
      removed: {
        purchases: 1,
        purchaseEvents: 1,
        receipts: 1,
        sellerOrders: 1,
        payouts: 1,
        refunds: 1,
        disputes: 1,
        jobs: 1,
        mandates: 1,
        wallets: 0,
      },
      seeded: { buyers: 1, sellers: 2, products: 7, flagged: 1 },
    });
    expect(await rowCounts(db)).toMatchObject({ purchases: 0, mandates: 0, wallets: 1, products: 7 });
  });

  it('removes the linked wallet too when full', async () => {
    const { status, body } = await answer(await POST(await request({ confirm: 'reset', full: true })));

    expect(status).toBe(200);
    expect(body.removed.wallets).toBe(1);
    expect(await rowCounts(db)).toMatchObject({ wallets: 0 });
  });

  it.each([
    ['no persona', null, 401, 'Pick a persona on the home page first.'],
    ['a forged cookie', 'forged', 401, 'Pick a persona on the home page first.'],
    ['the buyer persona', 'buyer', 403, 'Only the operator persona can do this.'],
    ['the seller persona', 'seller', 403, 'Only the operator persona can do this.'],
  ] as const)('refuses %s with %i and removes nothing', async (_, persona, status, message) => {
    const before = await rowCounts(db);

    expect(await answer(await POST(await request({ confirm: 'reset', full: true }, { persona })))).toEqual({
      status,
      body: { error: { message } },
    });
    expect(await rowCounts(db)).toEqual(before);
  });

  it.each([
    ['an empty body', ''],
    ['a body that is not JSON', '{'],
    ['a body without confirm', {}],
    ['full without confirm', { full: true }],
    ['the wrong confirm word', { confirm: 'yes' }],
    ['a confirm that is not a string', { confirm: true }],
    ['a full that is not true or false', { confirm: 'reset', full: 'yes' }],
    ['another field', { confirm: 'reset', everything: true }],
    ['an array', [{ confirm: 'reset' }]],
  ])('answers %s with 400 and removes nothing', async (_, body) => {
    const before = await rowCounts(db);

    expect(await answer(await POST(await request(body)))).toEqual({ status: 400, body: { error: { message: CONFIRM } } });
    expect(await rowCounts(db)).toEqual(before);
  });

  it('answers a body over 1 KiB with 413 and removes nothing', async () => {
    const before = await rowCounts(db);
    const body = JSON.stringify({ confirm: 'reset', padding: 'x'.repeat(1024) });

    expect(await answer(await POST(await request(body)))).toEqual({
      status: 413,
      body: { error: { message: 'This request is too large.' } },
    });
    expect(await rowCounts(db)).toEqual(before);
  });

  it('answers 500 without the cause when the payee email is not set, and removes nothing', async () => {
    vi.stubEnv('PAYEE_EMAIL', '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = await rowCounts(db);

    expect(await answer(await POST(await request({ confirm: 'reset' })))).toEqual({
      status: 500,
      body: { error: { message: 'The demo could not be reset, and nothing was removed. Try again.' } },
    });
    expect(await rowCounts(db)).toEqual(before);
    expect(logged).toHaveBeenCalledWith('[demo] Reset failed:', expect.any(Error));
  });
});
