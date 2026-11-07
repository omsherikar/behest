import { eq } from 'drizzle-orm';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/purchases/return/route';
import { appDb, purchaseDeps } from '@/lib/app-deps';
import { buyers, purchases } from '@/lib/db/schema';
import { completeApproval, startApproval } from '@/lib/purchases/approval';
import { MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { setUp } from '@/tests/helpers/purchase-deps';
import { purchaseRow, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
  purchaseDeps: vi.fn(),
}));
// The real completeApproval, watched, so a test can see what it was called with or make it throw.
vi.mock('@/lib/purchases/approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/purchases/approval')>();
  return { ...actual, completeApproval: vi.fn(actual.completeApproval) };
});
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

const SECRET = 'test-session-secret-at-least-32-characters';
const APPROVALS = 'https://behest.test/buyer/approvals';
const FAILED_LOG = '[purchases] Completing an approval on the buyer\'s return failed:';

/** PayPal sending the buyer back from approving `orderId`, as PayPal does: with the order as `token`, and the payer. */
async function paypalReturn(orderId: string | null, { persona = 'buyer' }: { persona?: Persona | 'forged' | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': '10.0.0.1, 203.0.113.7' });
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  const query = orderId === null ? '?PayerID=PAYER-1' : `?token=${encodeURIComponent(orderId)}&PayerID=PAYER-1`;
  return new NextRequest(`http://localhost/api/purchases/return${query}`, { headers });
}

/**
 * The demo buyer's purchase awaiting their approval at PayPal, with no saved wallet, and the app's
 * database and purchase flow pointing at it. The buyer has approved the order unless told otherwise.
 */
async function setUpAwaiting({ approve = true }: { approve?: boolean } = {}) {
  const s = await setUp('proposed', { wallet: null });
  await s.db.update(purchases).set({ gateVerdict: 'ASK', finalVerdict: 'ASK', approver: null }).where(eq(purchases.id, s.purchaseId));
  await startApproval(s.deps, s.purchaseId);
  const { paypalOrderId: orderId } = await purchaseRow(s.db, s.purchaseId);
  if (!orderId) throw new Error('the approval was not started');
  if (approve) s.paypal.approve(orderId);
  vi.mocked(appDb).mockReturnValue(s.db);
  vi.mocked(purchaseDeps).mockResolvedValue(s.deps);
  return { ...s, orderId };
}

const location = (response: Response) => response.headers.get('location');

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', 'https://behest.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('GET /api/purchases/return', () => {
  it('captures the approved order once and sends the buyer to approvals with the purchase approved; a second return changes nothing', async () => {
    const { db, paypal, purchaseId, orderId } = await setUpAwaiting();

    const first = await GET(await paypalReturn(orderId));

    expect(first.status).toBe(307);
    expect(location(first)).toBe(`${APPROVALS}?approved=${purchaseId}`);
    expect(connection).toHaveBeenCalled();
    expect(completeApproval).toHaveBeenCalledExactlyOnceWith(await vi.mocked(purchaseDeps).mock.results[0].value, orderId);
    expect(paypal.callsTo('captureOrder')).toEqual([[orderId, `${purchaseId}:capture`]]);
    expect(paypal.captures).toHaveLength(1);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'accepted', approver: 'human' });

    const second = await GET(await paypalReturn(orderId));

    expect(location(second)).toBe(`${APPROVALS}?approved=${purchaseId}`);
    expect(paypal.callsTo('captureOrder')).toHaveLength(1);
    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('sends a visitor without the buyer persona to approvals and completes nothing', async () => {
    const { db, paypal, purchaseId, orderId } = await setUpAwaiting();

    for (const persona of [null, 'forged', 'seller', 'operator'] as const) {
      const response = await GET(await paypalReturn(orderId, { persona }));
      expect(location(response)).toBe(APPROVALS);
    }

    expect(rateLimit).not.toHaveBeenCalled();
    expect(purchaseDeps).not.toHaveBeenCalled();
    expect(paypal.callsTo('captureOrder')).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it("never completes another buyer's order, and asks PayPal nothing", async () => {
    const { db, paypal, purchaseId } = await setUpAwaiting();
    const [other] = await db.insert(buyers).values({ name: 'Arjun' }).returning();
    const base = await purchaseRow(db, purchaseId);
    const [theirs] = await db
      .insert(purchases)
      .values({ ...base, id: undefined, createdAt: undefined, updatedAt: undefined, buyerId: other.id, paypalOrderId: 'ORDER-ARJUN' })
      .returning();

    const response = await GET(await paypalReturn('ORDER-ARJUN'));

    expect(location(response)).toBe(`${APPROVALS}?error=unknown`);
    expect(purchaseDeps).not.toHaveBeenCalled();
    expect(paypal.callsTo('captureOrder')).toEqual([]);
    expect(await statusOf(db, theirs.id)).toBe('awaiting_approval');
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it('sends the buyer to the unknown notice for an order no purchase was sent with, or no order at all', async () => {
    const { db, paypal, purchaseId } = await setUpAwaiting();

    for (const orderId of ['ORDER-NOPE', '', null]) {
      const response = await GET(await paypalReturn(orderId));
      expect(location(response)).toBe(`${APPROVALS}?error=unknown`);
    }

    expect(purchaseDeps).not.toHaveBeenCalled();
    expect(paypal.callsTo('captureOrder')).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it('sends the buyer to the pending notice when PayPal says the order is not approved yet', async () => {
    const { db, paypal, purchaseId, orderId } = await setUpAwaiting({ approve: false });

    const response = await GET(await paypalReturn(orderId));

    expect(location(response)).toBe(`${APPROVALS}?pending=${purchaseId}`);
    expect(paypal.callsTo('captureOrder')).toHaveLength(1);
    expect(paypal.captures).toEqual([]);
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'awaiting_approval', paypalOrderId: orderId });
  });

  it('logs a failure under a fixed prefix and sends the buyer to the failed notice, with nothing of the error in the link', async () => {
    const { db, paypal, purchaseId, orderId } = await setUpAwaiting();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(purchaseDeps).mockRejectedValueOnce(new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set'));

    const response = await GET(await paypalReturn(orderId));

    expect(location(response)).toBe(`${APPROVALS}?error=failed`);
    expect(logged).toHaveBeenCalledExactlyOnceWith(FAILED_LOG, {
      error: 'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set',
      errorClass: 'Error',
    });
    expect(paypal.callsTo('captureOrder')).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it('sends the buyer to the failed notice when completing the approval throws', async () => {
    const { db, purchaseId, orderId } = await setUpAwaiting();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(completeApproval).mockRejectedValueOnce(new TypeError('PayPal debug id 8c1f: connection reset'));

    const response = await GET(await paypalReturn(orderId));

    expect(location(response)).toBe(`${APPROVALS}?error=failed`);
    expect(logged).toHaveBeenCalledExactlyOnceWith(FAILED_LOG, { error: 'PayPal debug id 8c1f: connection reset', errorClass: 'TypeError' });
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });

  it('limits returns per client address with the model route limit, and completes nothing when limited', async () => {
    const { db, paypal, purchaseId, orderId } = await setUpAwaiting();
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    const limited = await GET(await paypalReturn(orderId));

    expect(location(limited)).toBe(`${APPROVALS}?error=failed`);
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith('purchase_return:203.0.113.7:buyer', MODEL_ROUTE_LIMIT);
    expect(purchaseDeps).not.toHaveBeenCalled();
    expect(paypal.callsTo('captureOrder')).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('awaiting_approval');
  });
});
