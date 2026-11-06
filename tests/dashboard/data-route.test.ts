import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/dashboard/data/route';
import { getDb, type Db } from '@/lib/db/client';
import { buyers, mandates } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import type { DashboardData } from '@/lib/dashboard/scope';
import { searchTransactions } from '@/lib/paypal';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/client')>()),
  getDb: vi.fn(),
}));
vi.mock('@/lib/paypal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/paypal')>()),
  searchTransactions: vi.fn(),
}));

const SECRET = 'test-session-secret-at-least-32-characters';

async function request(persona?: Persona | 'forged') {
  const headers = new Headers();
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/dashboard/data', { headers });
}

let db: Db;

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  db = await createTestDb();
  vi.mocked(getDb).mockReturnValue(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

// Each test reads a PGlite database, which can take several seconds on a busy machine.
describe('GET /api/dashboard/data', { timeout: 20_000 }, () => {
  it.each([undefined, 'forged'] as const)('refuses a request with cookie %s with 401', async (cookie) => {
    const response = await GET(await request(cookie));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: 'Pick a persona on the home page first.' } });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("returns the buyer's own rows, uncached, without asking PayPal", async () => {
    const [priya] = await db.insert(buyers).values({ name: DEMO_BUYER_NAME }).returning();
    const [other] = await db.insert(buyers).values({ name: 'Arjun' }).returning();
    const mandate = (buyerId: string) => ({
      buyerId,
      sourceText: '$60 a week',
      policy: {
        version: 1 as const,
        currency: 'USD' as const,
        budget: { amountCents: 6000, period: 'week' as const },
        perPurchaseMaxCents: 6000,
        askAboveCents: null,
        categories: { allow: null, deny: [] },
        merchants: { allow: null, deny: [] },
        velocity: null,
        expiresAt: null,
      },
      policyHash: 'a'.repeat(64),
      readback: [],
      readbackHash: 'a'.repeat(64),
      jws: 'mandate.jws.value',
      confirmedAt: new Date('2026-11-02T09:00:00Z'),
    });
    await db.insert(mandates).values([mandate(priya.id), mandate(other.id)]);

    const response = await GET(await request('buyer'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(connection).toHaveBeenCalled();
    const data = (await response.json()) as DashboardData;
    expect(data.persona).toBe('buyer');
    expect(data.mandates.map((m) => m.buyerId)).toEqual([priya.id]);
    expect(searchTransactions).not.toHaveBeenCalled();
  });

  it('answers the operator with a warning when Transaction Search fails', async () => {
    vi.mocked(searchTransactions).mockRejectedValue(new Error('PayPal 503 on /v1/reporting/transactions'));
    const response = await GET(await request('operator'));
    expect(response.status).toBe(200);
    const data = (await response.json()) as DashboardData;
    expect(data.transactions).toEqual([]);
    expect(data.warnings).toEqual(['PayPal transactions could not be loaded: PayPal 503 on /v1/reporting/transactions']);
  });
});
