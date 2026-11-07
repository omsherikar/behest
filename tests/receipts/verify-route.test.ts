import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/receipts/verify/route';
import { sellerDeps } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import { PUBLIC_READ_LIMIT, rateLimit } from '@/lib/ratelimit';
import { acceptAgentOrder } from '@/lib/sellers/intake';
import { raviCart, RECEIPT_ISSUED, receiptFor, receiptJwks, signReceipt } from '@/tests/helpers/receipts';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  sellerDeps: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

/** Five minutes after the receipts are issued. */
const NOW = new Date(RECEIPT_ISSUED.getTime() + 5 * 60 * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;

/** A receipt check from anyone, with no session. */
const verify = (body: unknown) =>
  POST(
    new NextRequest('http://localhost/api/receipts/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;
let statements: string[];
const deps = () => ({ db, jwks: async () => receiptJwks, now: () => NOW });

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  statements = [];
  db = await createTestDb({ logger: { logQuery: (query) => statements.push(query) } });
  await db.insert(sellers).values({ slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' });
  vi.mocked(sellerDeps).mockReturnValue(deps());
  statements.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

/** The statements run since the last call that change something. */
const writes = () => statements.filter((sql) => !sql.startsWith('select '));

describe('POST /api/receipts/verify', () => {
  it('checks in intake mode by default and answers 200 with the payload of a receipt that passes', async () => {
    const payload = receiptFor(raviCart);

    expect(await answer(await verify({ jws: await signReceipt(payload), cart: raviCart, sellerSlug: 'ravi-spices' }))).toEqual({
      status: 200,
      body: { ok: true, payload },
    });
    expect(connection).toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('answers a failed check with 200 and its reason', async () => {
    const jws = await signReceipt(receiptFor(raviCart, new Date(NOW.getTime() - 2 * DAY_MS)));

    expect(await answer(await verify({ jws, cart: raviCart, sellerSlug: 'ravi-spices', mode: 'intake' }))).toEqual({
      status: 200,
      body: { ok: false, reason: 'expired' },
    });
  });

  it('in intake mode answers replayed for a receipt whose order was accepted, and records nothing', async () => {
    const jws = await signReceipt(receiptFor(raviCart));
    await acceptAgentOrder(deps(), { sellerSlug: 'ravi-spices', cart: raviCart, receiptJws: jws });
    statements.length = 0;

    expect(await answer(await verify({ jws, cart: raviCart, sellerSlug: 'ravi-spices' }))).toEqual({
      status: 200,
      body: { ok: false, reason: 'replayed' },
    });
    expect(writes()).toEqual([]);
    expect(await db.select().from(sellerOrders)).toHaveLength(1);
  });

  it('in audit mode passes a receipt issued two days ago and already used, and never touches the database', async () => {
    const payload = receiptFor(raviCart, new Date(NOW.getTime() - 2 * DAY_MS));
    const jws = await signReceipt(payload);
    await db.insert(sellerOrders).values({
      sellerId: (await db.select({ id: sellers.id }).from(sellers))[0].id,
      receiptId: payload.id,
      status: 'accepted',
      cart: raviCart,
      receiptJws: jws,
    });
    statements.length = 0;

    expect(await answer(await verify({ jws, cart: raviCart, sellerSlug: 'ravi-spices', mode: 'audit' }))).toEqual({
      status: 200,
      body: { ok: true, payload },
    });
    expect(statements).toEqual([]);
  });

  it('in audit mode still answers a cart that does not match with its reason', async () => {
    const jws = await signReceipt(receiptFor(raviCart, new Date(NOW.getTime() - 2 * DAY_MS)));
    const cart = { ...raviCart, items: [raviCart.items[0]], totalCents: 900 };

    expect(await answer(await verify({ jws, cart, sellerSlug: 'ravi-spices', mode: 'audit' }))).toEqual({
      status: 200,
      body: { ok: false, reason: 'cart_mismatch' },
    });
    expect(statements).toEqual([]);
  });

  it.each([
    ['a body that is not JSON', '{', 'Send the receipt check as JSON: { jws, cart, sellerSlug, mode? }.'],
    ['a check with no receipt', { cart: raviCart, sellerSlug: 'ravi-spices' }, 'jws: jws must be the receipt as a compact JWS.'],
    ['a check with no seller', { jws: 'x', cart: raviCart }, 'sellerSlug: sellerSlug must name the seller.'],
    ['an unknown mode', { jws: 'x', cart: raviCart, sellerSlug: 'ravi-spices', mode: 'strict' }, "mode: mode must be 'intake' or 'audit'."],
    ['a cart with no items', { jws: 'x', cart: { ...raviCart, items: [] }, sellerSlug: 'ravi-spices' }, expect.stringMatching(/^cart\.items: /)],
  ])('answers %s with 400', async (_, body, message) => {
    expect(await answer(await verify(body))).toEqual({ status: 400, body: { error: { message } } });
    expect(statements).toEqual([]);
  });

  it('refuses a body over 64 KiB with 413 before reading it as JSON', async () => {
    expect(await answer(await verify({ jws: 'a'.repeat(64 * 1024), cart: raviCart, sellerSlug: 'ravi-spices' }))).toEqual({
      status: 413,
      body: { error: { message: 'This request is too large.' } },
    });
  });

  it('counts checks per address against the public read limit, and answers 429 past it', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await verify({ jws: 'x', cart: raviCart, sellerSlug: 'ravi-spices' }))).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });
    expect(rateLimit).toHaveBeenCalledWith('receipt_verify:198.51.100.4', PUBLIC_READ_LIMIT);
  });
});
