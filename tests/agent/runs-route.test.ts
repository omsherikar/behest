import Anthropic from '@anthropic-ai/sdk';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/agent/runs/route';
import { appDb, llmDeps, purchaseDeps } from '@/lib/app-deps';
import { searchMarket } from '@/lib/channel3/client';
import { buyers, llmCalls, mandates, products, purchases, sellers, wallets } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { takeSlot } from '@/lib/inflight';
import { MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { hashOf } from '@/lib/receipts/canonical';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import { fakeClaude, messageJson, type FakeToolUse } from '@/tests/helpers/fake-claude';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { FakeSeller, NOW, signer } from '@/tests/helpers/purchase-deps';
import { SEEDED_SELLER } from '@/tests/helpers/seed-purchase';
import { sseEvents } from '@/tests/helpers/sse';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
  llmDeps: vi.fn(),
  purchaseDeps: vi.fn(),
}));
vi.mock('@/lib/channel3/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channel3/client')>()),
  searchMarket: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

const SECRET = 'test-session-secret-at-least-32-characters';
const REQUEST = 'Restock turmeric.\nOne bag is enough.';
const SUMMARY = 'I bought one 100g bag of turmeric from Ravi for $4.50.';
const RUN_FAILED = 'Your agent stopped because something went wrong. Check your purchases, then try again.';
const BUSY = { error: { message: 'Your agent is already shopping. Wait for it to finish.' } };

const searchCall: FakeToolUse = { id: 'toolu_search', name: 'search_sellers', input: { query: 'turmeric' } };
const marketCall: FakeToolUse = { id: 'toolu_market', name: 'search_market', input: { query: 'turmeric 100g' } };
const proposeCall: FakeToolUse = {
  id: 'toolu_propose',
  name: 'propose_purchase',
  input: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'TUR-100', quantity: 1 }], rationale: 'The buyer asked for turmeric.' },
};

/** A request to the route. `signal` stands in for the one Next.js aborts when the client goes away. */
async function request(
  body: unknown,
  { persona = 'buyer', signal }: { persona?: Persona | 'forged' | null; signal?: AbortSignal } = {},
) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1, 203.0.113.7' });
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/agent/runs', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });
}

/**
 * The demo buyer with an active mandate unless told otherwise and a linked wallet, the demo seller's
 * turmeric, and the app's database, purchase flow and Claude all pointing at them, Claude sending
 * each request through `send`.
 */
async function setUp(send: typeof fetch, { mandate = true }: { mandate?: boolean } = {}) {
  const db = await createTestDb();
  const [buyer] = await db.insert(buyers).values({ name: DEMO_BUYER_NAME }).returning();
  const [seller] = await db.insert(sellers).values(SEEDED_SELLER).returning();
  await db
    .insert(products)
    .values({ sellerId: seller.id, sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', priceCents: 450, stock: 40 });
  if (mandate) {
    const readback = ['Up to $60.00 a month.'];
    await db.insert(mandates).values({
      buyerId: buyer.id,
      sourceText: '$60 a month on spices',
      policy: demoPolicy,
      policyHash: hashOf(demoPolicy),
      readback,
      readbackHash: hashOf(readback),
      jws: 'mandate.jws.value',
      confirmedAt: new Date('2026-11-01T09:00:00Z'),
    });
  }
  await db
    .insert(wallets)
    .values({ buyerId: buyer.id, status: 'linked', paypalCustomerId: 'CUSTOMER-1', paymentTokenId: 'TOKEN-1', linkedAt: NOW });

  const now = () => NOW;
  vi.mocked(appDb).mockReturnValue(db);
  vi.mocked(llmDeps).mockImplementation(() => ({
    db,
    claude: new Anthropic({ apiKey: 'test', fetch: send, maxRetries: 0 }),
    now,
    env: { NODE_ENV: 'test' },
  }));
  vi.mocked(purchaseDeps).mockImplementation(async () => ({
    db,
    paypal: new FakePaypal(),
    signer,
    intent: async () => ({ verdict: 'consistent', reasons: [] }),
    sellers: new FakeSeller(now),
    appUrl: 'https://behest.example.com',
    now,
  }));
  return { db, buyerId: buyer.id };
}

/** Claude answering with `replies` in order. */
async function claudeAnswers(replies: object[], options?: { mandate?: boolean }) {
  const fake = fakeClaude(replies);
  return { fake, ...(await setUp(fake.fetch, options)) };
}

/**
 * Claude holding its first reply until the test answers, then answering each request with the
 * next of `replies`. `asked` settles once the first request has arrived.
 */
async function heldClaude(replies: object[]) {
  const fake = fakeClaude(replies);
  let asked!: () => void;
  let answer!: () => void;
  const wasAsked = new Promise<void>((resolve) => (asked = resolve));
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const send: typeof fetch = async (input, init) => {
    asked();
    await answered;
    return fake.fetch(input, init);
  };
  return { fake, asked: wasAsked, answer, ...(await setUp(send)) };
}

/** Whether the buyer's one run slot is free: takes it, then gives it back. */
function slotFree(buyerId: string): boolean {
  const slot = takeSlot(`agent_run:${buyerId}`, 1);
  slot?.();
  return slot !== null;
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('CHANNEL3_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/agent/runs', () => {
  it("streams the run as server-sent events, buying with the buyer's own request", async () => {
    const { db, fake } = await claudeAnswers([
      messageJson({ toolUses: [searchCall] }),
      messageJson({ toolUses: [proposeCall] }),
      messageJson({ text: SUMMARY }),
    ]);

    const response = await POST(await request({ request: REQUEST }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(connection).toHaveBeenCalled();
    const text = await response.text();
    expect(text).toMatch(/^event: status\ndata: \{"type":"status"/);
    const [purchase] = await db.select().from(purchases);
    expect(sseEvents(text)).toEqual([
      { type: 'status', text: 'Your agent is looking for what you asked for.' },
      { type: 'tool', name: 'search_sellers', input: { query: 'turmeric' } },
      { type: 'tool', name: 'propose_purchase', input: proposeCall.input },
      { type: 'proposal', outcome: expect.objectContaining({ purchaseId: purchase.id, verdict: 'ALLOW', status: purchase.status }) },
      { type: 'done', summary: SUMMARY },
    ]);
    expect(purchase.request).toBe(REQUEST);
    expect(fake.requests).toHaveLength(3);
  });

  it('asks for a mandate first, in the stream, without calling the model', async () => {
    const { fake } = await claudeAnswers([messageJson({ text: SUMMARY })], { mandate: false });

    const response = await POST(await request({ request: REQUEST }));

    expect(response.status).toBe(200);
    expect(sseEvents(await response.text())).toEqual([{ type: 'error', message: 'Sign a mandate first.' }]);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([null, 'forged'] as const)('refuses a request with persona %s with 401, before any work', async (persona) => {
    const response = await POST(await request({ request: REQUEST }, { persona }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: 'Pick a persona on the home page first.' } });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(appDb).not.toHaveBeenCalled();
  });

  it.each(['seller', 'operator'] as const)('refuses the %s persona with 403, before any work', async (persona) => {
    const response = await POST(await request({ request: REQUEST }, { persona }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Only the buyer persona can do this.' } });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(appDb).not.toHaveBeenCalled();
  });

  it('limits each client address with the model route limit, before any work', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    const response = await POST(await request('not json'));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: 'Too many requests at once. Try again in a minute.' } });
    expect(rateLimit).toHaveBeenCalledExactlyOnceWith('agent_run:203.0.113.7:buyer', MODEL_ROUTE_LIMIT);
    expect(appDb).not.toHaveBeenCalled();
  });

  it('refuses a body over 8 KiB with 413', async () => {
    const response = await POST(await request({ request: 'x'.repeat(8 * 1024) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { message: 'This request is too large.' } });
    expect(appDb).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'not json', 'Send your request as JSON.'],
    ['a body that is not an object', '["Buy turmeric"]', 'Send your request as JSON.'],
    ['no request', {}, 'Tell your agent what to buy first.'],
    ['a request that is not text', { request: 42 }, 'Tell your agent what to buy first.'],
    ['an empty request', { request: '' }, 'Tell your agent what to buy first.'],
    ['a request of only spaces and line breaks', { request: ' \n\t ' }, 'Tell your agent what to buy first.'],
    ['a request over 2,000 characters', { request: 'x'.repeat(2_001) }, 'Keep your request to 2,000 characters or fewer.'],
  ])('refuses %s with 400 and calls no model', async (_, body, message) => {
    const response = await POST(await request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message } });
    expect(appDb).not.toHaveBeenCalled();
    expect(llmDeps).not.toHaveBeenCalled();
  });

  it('accepts a request of exactly 2,000 characters', async () => {
    const { fake } = await claudeAnswers([messageJson({ text: SUMMARY })]);
    const longest = 'x'.repeat(2_000);

    const response = await POST(await request({ request: longest }));

    expect(response.status).toBe(200);
    await response.text();
    expect((fake.requests[0].body.messages as { content: string }[])[0].content).toContain(`<request>\n${longest}\n</request>`);
  });

  it('gives the agent market prices from Channel3 when CHANNEL3_API_KEY is set', async () => {
    vi.stubEnv('CHANNEL3_API_KEY', 'ch3-test-key');
    vi.mocked(searchMarket).mockResolvedValue([]);
    await claudeAnswers([messageJson({ toolUses: [marketCall] }), messageJson({ text: SUMMARY })]);

    await (await POST(await request({ request: REQUEST }))).text();

    expect(searchMarket).toHaveBeenCalledExactlyOnceWith('turmeric 100g');
  });

  it('tells the agent market prices are not available when CHANNEL3_API_KEY is not set', async () => {
    const { fake } = await claudeAnswers([messageJson({ toolUses: [marketCall] }), messageJson({ text: SUMMARY })]);

    await (await POST(await request({ request: REQUEST }))).text();

    expect(searchMarket).not.toHaveBeenCalled();
    const sent = fake.requests[1].body.messages as { content: { type: string; content: string }[] }[];
    expect(sent[2].content[0]).toMatchObject({ type: 'tool_result', content: 'Market prices are not available right now.' });
  });

  it('runs one agent at a time per buyer, and frees the slot when the run ends', async () => {
    const claude = await heldClaude([messageJson({ text: SUMMARY }), messageJson({ text: SUMMARY })]);

    const first = await POST(await request({ request: REQUEST }));
    await claude.asked;
    const second = await POST(await request({ request: REQUEST }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual(BUSY);

    claude.answer();
    expect(sseEvents(await first.text()).at(-1)).toEqual({ type: 'done', summary: SUMMARY });
    expect(slotFree(claude.buyerId)).toBe(true);
    const third = await POST(await request({ request: REQUEST }));
    expect(third.status).toBe(200);
    await third.text();
    expect(claude.fake.requests).toHaveLength(2);
  });

  it('sends one error event with a fixed message when the run throws, logs why, and frees the slot', async () => {
    const { fake, buyerId } = await claudeAnswers([messageJson({ text: SUMMARY })]);
    const misconfigured = new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
    vi.mocked(purchaseDeps).mockRejectedValueOnce(misconfigured);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(await request({ request: REQUEST }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(sseEvents(text)).toEqual([{ type: 'error', message: RUN_FAILED }]);
    expect(text).not.toContain('PAYPAL');
    expect(errors).toHaveBeenCalledExactlyOnceWith('[agent] The run failed:', misconfigured);
    expect(fake.requests).toHaveLength(0);
    expect(slotFree(buyerId)).toBe(true);
  });

  it.each(['the client goes away', 'the reader cancels'] as const)(
    'stops the run at its next turn boundary when %s, and frees the slot once the run has stopped',
    async (how) => {
      const claude = await heldClaude([messageJson({ toolUses: [proposeCall] }), messageJson({ text: SUMMARY })]);
      const client = new AbortController();

      const response = await POST(await request({ request: REQUEST }, { signal: client.signal }));
      const reader = response.body!.getReader();
      await reader.read();
      await claude.asked;
      if (how === 'the client goes away') client.abort();
      else await reader.cancel();

      // The run waits on the model, so the buyer's one slot is still taken.
      expect((await POST(await request({ request: REQUEST }))).status).toBe(429);
      claude.answer();
      await vi.waitFor(() => expect(slotFree(claude.buyerId)).toBe(true), { timeout: 10_000 });

      // The reply was logged, its proposal never ran, and no other request went out.
      expect(await claude.db.select().from(llmCalls)).toHaveLength(1);
      expect(await claude.db.select().from(purchases)).toHaveLength(0);
      expect(claude.fake.requests).toHaveLength(1);
      if (how === 'the client goes away') expect(await reader.read()).toEqual({ done: true, value: undefined });
    },
  );
});
