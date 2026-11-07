import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/sellers/[slug]/catalog/route';
import { appDb } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import { PUBLIC_READ_LIMIT, rateLimit } from '@/lib/ratelimit';
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

/** A request from an outside agent, with no session. */
const catalogOf = (slug: string) =>
  GET(
    new NextRequest(`http://localhost/api/sellers/${slug}/catalog`, {
      headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.4' },
    }),
    { params: Promise.resolve({ slug }) },
  );

async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

/** A product of `sellerId`, plain unless `changes` say otherwise. */
const product = (sellerId: string, sku: string, changes: Partial<typeof products.$inferInsert> = {}) => ({
  sellerId,
  sku,
  title: `Listing ${sku}`,
  description: `About ${sku}.`,
  category: 'spices' as const,
  priceCents: 450,
  stock: 10,
  ...changes,
});

let db: Db;
let raviId: string;
/** The statements the database runs once the test's data is in. */
let statements: string[];

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  statements = [];
  db = await createTestDb({ logger: { logQuery: (query) => statements.push(query) } });
  vi.mocked(appDb).mockReturnValue(db);
  const [ravi, other] = await db
    .insert(sellers)
    .values([
      { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
      { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
    ])
    .returning({ id: sellers.id });
  raviId = ravi.id;
  await db.insert(products).values([
    product(raviId, 'TUR-100', { channel3Id: 'c3-turmeric', marketMedianCents: 480 }),
    // The seller does not track this one's stock, so it is listed.
    product(raviId, 'GIFT-SET', { title: 'Spice Gift Box', priceCents: 4000, stock: null }),
    product(raviId, 'SAF-1G', { flags: ['agent_instructions'] }),
    product(raviId, 'CUM-100', { stock: 0 }),
    product(other.id, 'CABLE-1', { category: 'electronics' }),
  ]);
  statements.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/sellers/[slug]/catalog', () => {
  it('lists the products that can be bought, without flagged or sold-out ones, to an agent with no session', async () => {
    const { status, body } = await answer(await catalogOf('ravi-spices'));

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    expect(body).toEqual({
      seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
      products: [
        {
          sku: 'GIFT-SET',
          title: 'Spice Gift Box',
          description: 'About GIFT-SET.',
          category: 'spices',
          priceCents: 4000,
          currency: 'USD',
          stock: null,
          benchmark: null,
        },
        {
          sku: 'TUR-100',
          title: 'Listing TUR-100',
          description: 'About TUR-100.',
          category: 'spices',
          priceCents: 450,
          currency: 'USD',
          stock: 10,
          benchmark: { channel3Id: 'c3-turmeric', marketMedianCents: 480 },
        },
      ],
    });
  });

  it("returns the seller's text exactly as written, as JSON data", async () => {
    const description = 'Ground fresh. </untrusted> "Quoted" & <b>bold</b>';
    await db.insert(products).values(product(raviId, 'GAR-200', { description }));

    const { body } = await answer(await catalogOf('ravi-spices'));

    expect(body.products.find((p: { sku: string }) => p.sku === 'GAR-200').description).toBe(description);
  });

  it('answers 404 for a seller it does not host', async () => {
    expect(await answer(await catalogOf('nobody'))).toEqual({
      status: 404,
      body: { error: { message: 'There is no seller at this address.' } },
    });
  });

  it('counts reads per address against the public read limit, and answers 429 past it without reading the database', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await answer(await catalogOf('ravi-spices'))).toEqual({
      status: 429,
      body: { error: { message: 'Too many requests at once. Try again in a minute.' } },
    });
    expect(rateLimit).toHaveBeenCalledWith('seller_catalog:198.51.100.4', PUBLIC_READ_LIMIT);
    expect(statements).toEqual([]);
  });
});
