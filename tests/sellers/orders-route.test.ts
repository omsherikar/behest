import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/sellers/[slug]/orders/route';
import { sellerDeps } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import { PUBLIC_WRITE_LIMIT, rateLimit } from '@/lib/ratelimit';
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

/** An order from an outside agent, with no session. */
const placeOrder = (body: unknown, slug = 'ravi-spices') =>
  POST(
    new NextRequest(`http://localhost/api/sellers/${slug}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1, 198.51.100.4' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

let db: Db;

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  db = await createTestDb();
  await db.insert(sellers).values({ slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' });
  vi.mocked(sellerDeps).mockReturnValue({ db, jwks: async () => receiptJwks, now: () => NOW });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/sellers/[slug]/orders', () => {
  it('answers 201 for an order with a valid receipt, and 422 replayed when the receipt comes again', async () => {
    const order = { cart: raviCart, receiptJws: await signReceipt(receiptFor(raviCart)) };

    expect(await answer(await placeOrder(order))).toEqual({ status: 201, body: { status: 'accepted' } });
    expect(await answer(await placeOrder(order))).toEqual({
      status: 422,
      body: { status: 'rejected', reason: 'replayed' },
    });
    expect(connection).toHaveBeenCalled();
    expect((await db.select().from(sellerOrders)).map((row) => [row.status, row.reason])).toEqual(
      expect.arrayContaining([
        ['accepted', null],
        ['rejected', 'replayed'],
      ]),
    );
  });

  it('answers 422 with the reason for a receipt that does not verify', async () => {
    expect(await answer(await placeOrder({ cart: raviCart, receiptJws: 'not-a-jws' }))).toEqual({
      status: 422,
      body: { status: 'rejected', reason: 'malformed' },
    });
  });

  it('answers 404 for a seller it does not host, recording nothing', async () => {
    const order = { cart: raviCart, receiptJws: await signReceipt(receiptFor(raviCart)) };

    expect(await answer(await placeOrder(order, 'nobody'))).toEqual({
      status: 404,
      body: { error: { message: 'There is no seller at this address.' } },
    });
    expect(await db.select().from(sellerOrders)).toEqual([]);
  });

  it.each([
    ['a body that is not JSON', '{', 'Send the order as JSON: { cart, receiptJws }.'],
    ['an order with no receipt', { cart: raviCart }, 'receiptJws: receiptJws must be the receipt as a compact JWS.'],
    [
      'a cart whose total is not the sum of its items',
      { cart: { ...raviCart, totalCents: 1 }, receiptJws: 'x' },
      'cart.totalCents: totalCents must equal the sum of the items',
    ],
  ])('answers %s with 400, recording nothing', async (_, body, message) => {
    expect(await answer(await placeOrder(body))).toEqual({ status: 400, body: { error: { message } } });
    expect(await db.select().from(sellerOrders)).toEqual([]);
  });

  it('refuses a body over 64 KiB with 413 before reading it as JSON', async () => {
    expect(await answer(await placeOrder({ cart: raviCart, receiptJws: 'a'.repeat(64 * 1024) }))).toEqual({
      status: 413,
      body: { error: { message: 'This request is too large.' } },
    });
    expect(await db.select().from(sellerOrders)).toEqual([]);
  });

  it('counts orders per address against the public write limit, and answers 429 past it', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await placeOrder({ cart: raviCart, receiptJws: 'x' }))).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });
    expect(rateLimit).toHaveBeenCalledWith('seller_orders:198.51.100.4', PUBLIC_WRITE_LIMIT);
    expect(sellerDeps).not.toHaveBeenCalled();
    expect(await db.select().from(sellerOrders)).toEqual([]);
  });
});
