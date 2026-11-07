import Anthropic from '@anthropic-ai/sdk';
import { asc } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHOPPING_SYSTEM_PROMPT } from '@/lib/agent/prompt';
import { type AgentEvent, runShoppingAgent } from '@/lib/agent/run';
import type { MarketSearch } from '@/lib/agent/tools';
import { buyers, llmCalls, mandates, products, purchases, receipts, sellers, wallets, type MandateStatus } from '@/lib/db/schema';
import { createClaude, recordCall } from '@/lib/llm/client';
import type { IntentInput, IntentResult, PurchaseDeps } from '@/lib/purchases/deps';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { fakeClaude, messageJson, type FakeToolUse } from '@/tests/helpers/fake-claude';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { FakeSeller, NOW, signer } from '@/tests/helpers/purchase-deps';
import { SEEDED_SELLER } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

const REQUEST = 'Restock turmeric.\nOne bag is enough.';
const READBACK = ['Up to $60.00 a month.', 'Ask me before any purchase over $25.00.', 'Never electronics.'];
const RATIONALE = 'Turmeric is what the buyer asked for, and this bag is the cheapest.';
const SUMMARY = 'I bought one 100g bag of turmeric from Ravi for $4.50. It is paid.';

const RUN_FAILED = 'Your agent stopped because something went wrong. Check your purchases, then try again.';

const searchCall = (id: string): FakeToolUse => ({ id, name: 'search_sellers', input: { query: 'turmeric' } });
const proposeCall: FakeToolUse = {
  id: 'toolu_propose',
  name: 'propose_purchase',
  input: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'TUR-100', quantity: 1 }], rationale: RATIONALE },
};

const SERVER_ERROR = {
  status: 500,
  headers: { 'retry-after-ms': '0' },
  body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
};

/** The intent check, answering consistent unless told otherwise, and running `whileChecking` first. */
class FakeIntent {
  readonly inputs: IntentInput[] = [];
  whileChecking: () => void = () => {};

  async check(input: IntentInput): Promise<IntentResult> {
    this.inputs.push(input);
    this.whileChecking();
    return { verdict: 'consistent', reasons: [] };
  }
}

/**
 * A buyer with a mandate in `mandate` status (or none) and a linked wallet, the demo seller's
 * catalog, a fake PayPal, a fake seller, a fake intent check and Claude answering with `replies`.
 */
async function setUp(
  replies: object[],
  {
    mandate = 'active',
    expiresAt = null,
    search,
    claude,
  }: { mandate?: MandateStatus | null; expiresAt?: Date | null; search?: MarketSearch; claude?: Anthropic } = {},
) {
  const db = await createTestDb();
  const [buyer] = await db.insert(buyers).values({ name: 'Priya' }).returning();
  const [seller] = await db.insert(sellers).values(SEEDED_SELLER).returning();
  await db.insert(products).values([
    { sellerId: seller.id, sku: 'TUR-100', title: 'Turmeric powder 100g', category: 'spices', priceCents: 450, stock: 40 },
    { sellerId: seller.id, sku: 'GAR-200', title: 'Garam masala 200g', category: 'spices', priceCents: 600, stock: 25 },
  ]);
  if (mandate) {
    await db.insert(mandates).values({
      buyerId: buyer.id,
      sourceText: '$60 a month on groceries and spices, ask me above $25, never electronics',
      policy: demoPolicy,
      policyHash: hashOf(demoPolicy),
      readback: READBACK,
      readbackHash: hashOf(READBACK),
      jws: 'mandate.jws.value',
      status: mandate,
      confirmedAt: new Date('2026-11-01T09:00:00Z'),
      expiresAt,
    });
  }
  await db.insert(wallets).values({
    buyerId: buyer.id,
    status: 'linked',
    paypalCustomerId: 'CUSTOMER-1',
    paymentTokenId: 'TOKEN-1',
    linkedAt: NOW,
  });
  const fake = fakeClaude(replies);
  const paypal = new FakePaypal();
  const intent = new FakeIntent();
  const now = () => NOW;
  const purchaseDeps: PurchaseDeps = {
    db,
    paypal,
    signer,
    intent: (input) => intent.check(input),
    sellers: new FakeSeller(now),
    appUrl: 'https://behest.example.com',
    now,
  };
  const deps = {
    db,
    claude: claude ?? new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries: 0 }),
    now,
    env: { NODE_ENV: 'test' as const },
    purchases: purchaseDeps,
    search,
  };
  const events: AgentEvent[] = [];
  const run = (signal?: AbortSignal) =>
    runShoppingAgent(deps, { buyerId: buyer.id, request: REQUEST, onEvent: (event) => events.push(event), signal });
  return { db, fake, paypal, intent, deps, events, run, buyerId: buyer.id };
}

const STARTED = { type: 'status', text: 'Your agent is looking for what you asked for.' };

// The first createTestDb() call in a file migrates a template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('runShoppingAgent', () => {
  it('searches, proposes, and ends with one proposal event and done', async () => {
    const s = await setUp([
      messageJson({ toolUses: [searchCall('toolu_search')] }),
      messageJson({ toolUses: [proposeCall] }),
      messageJson({ text: SUMMARY }),
    ]);

    const result = await s.run();

    const [purchase] = await s.db.select().from(purchases);
    expect(result).toEqual({ runId: expect.any(String), outcomes: [expect.objectContaining({ purchaseId: purchase.id })], summary: SUMMARY });
    expect(result.outcomes[0]).toMatchObject({ verdict: 'ALLOW', status: purchase.status });
    expect(s.events).toEqual([
      STARTED,
      { type: 'tool', name: 'search_sellers', input: { query: 'turmeric' } },
      { type: 'tool', name: 'propose_purchase', input: proposeCall.input },
      { type: 'proposal', outcome: result.outcomes[0] },
      { type: 'done', summary: SUMMARY },
    ]);
    expect(s.paypal.calls.map((call) => call.method)).toContain('chargeSavedWallet');
    expect(console.error).not.toHaveBeenCalled();
  });

  it("gives the purchase the run id and the buyer's own request, never the agent's words", async () => {
    const s = await setUp([messageJson({ toolUses: [proposeCall] }), messageJson({ text: SUMMARY })]);

    const { runId } = await s.run();

    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await s.db.select({ runId: purchases.runId, request: purchases.request }).from(purchases)).toEqual([
      { runId, request: REQUEST },
    ]);
    expect(s.intent.inputs.map((input) => input.request)).toEqual([REQUEST]);
  });

  it('sends the shopping prompt, and a first message holding the request and the mandate readback', async () => {
    const s = await setUp([messageJson({ text: SUMMARY })]);

    await s.run();

    const [sent] = s.fake.requests;
    expect(sent.headers['x-behest-route']).toBe('shopping_agent');
    expect(sent.body.system).toBe(SHOPPING_SYSTEM_PROMPT);
    expect(sent.body.tools).toEqual(
      ['search_sellers', 'search_market', 'get_product', 'propose_purchase'].map((name) => expect.objectContaining({ name })),
    );
    const messages = sent.body.messages as { role: string; content: string }[];
    expect(messages).toEqual([{ role: 'user', content: expect.any(String) }]);
    expect(messages[0].content).toContain(`<request>\n${REQUEST}\n</request>`);
    expect(messages[0].content).toContain(`<mandate>\n${READBACK.join('\n')}\n</mandate>`);
  });

  it('runs at most 12 turns, then says the agent ran out of steps', async () => {
    const s = await setUp(Array.from({ length: 13 }, (_, i) => messageJson({ toolUses: [searchCall(`toolu_${i}`)] })));

    const result = await s.run();

    expect(s.fake.requests).toHaveLength(12);
    expect(await s.db.select().from(llmCalls)).toHaveLength(12);
    expect(s.events.filter((event) => event.type === 'tool')).toHaveLength(12);
    const outOfSteps = 'Your agent ran out of steps before it finished. Each proposal it made is shown above.';
    expect(s.events.at(-1)).toEqual({ type: 'done', summary: outOfSteps });
    expect(result.summary).toBe(outOfSteps);
  });

  it.each([
    ['no mandate', { mandate: null }],
    ['a revoked mandate', { mandate: 'revoked' as const }],
    ['an expired mandate', { mandate: 'expired' as const }],
    ['an active mandate past its end', { expiresAt: NOW }],
  ])('asks for a mandate first, and calls no model, for a buyer with %s', async (_, options) => {
    const s = await setUp([messageJson({ toolUses: [proposeCall] })], options);

    const result = await s.run();

    expect(s.events).toEqual([{ type: 'error', message: 'Sign a mandate first.' }]);
    expect(result).toEqual({ runId: expect.any(String), outcomes: [], summary: '' });
    expect(s.fake.requests).toHaveLength(0);
    expect(await s.db.select().from(llmCalls)).toHaveLength(0);
    expect(await s.db.select().from(purchases)).toHaveLength(0);
  });

  it('runs for an active mandate that has not reached its end', async () => {
    const s = await setUp([messageJson({ text: SUMMARY })], { expiresAt: new Date(NOW.getTime() + 1) });

    await s.run();

    expect(s.events).toEqual([STARTED, { type: 'done', summary: SUMMARY }]);
  });

  it('emits one error event and buys nothing when the loop fails, and logs why', async () => {
    const s = await setUp([SERVER_ERROR, messageJson({ toolUses: [proposeCall] })]);

    const result = await s.run();

    expect(s.events).toEqual([STARTED, { type: 'error', message: RUN_FAILED }]);
    expect(result).toEqual({ runId: expect.any(String), outcomes: [], summary: '' });
    expect(await s.db.select().from(purchases)).toHaveLength(0);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('api_error'));
  });

  it('never passes on what the model wrote when the loop fails', async () => {
    const declined = messageJson({ text: 'I will not help with this.', stop_reason: 'refusal' });
    const s = await setUp([declined]);

    await s.run();

    expect(s.events).toEqual([
      STARTED,
      { type: 'error', message: 'Your agent could not take on this request. Try rewording it.' },
    ]);
  });

  it("says when today's model budget is spent, without calling the model", async () => {
    const s = await setUp([messageJson({ text: SUMMARY })]);
    await recordCall(s.db, { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 5, createdAt: NOW });

    await s.run();

    expect(s.events).toEqual([
      STARTED,
      { type: 'error', message: "Behest has used today's budget for model calls. Try again tomorrow." },
    ]);
    expect(s.fake.requests).toHaveLength(0);
  });

  it('records the outcome of a proposal running when the buyer leaves, then stops without another request', async () => {
    const s = await setUp([messageJson({ toolUses: [proposeCall] }), messageJson({ text: SUMMARY })]);
    const buyerLeaves = new AbortController();
    s.intent.whileChecking = () => buyerLeaves.abort();

    const result = await s.run(buyerLeaves.signal);

    const [purchase] = await s.db.select().from(purchases);
    expect(result.outcomes).toEqual([expect.objectContaining({ purchaseId: purchase.id, verdict: 'ALLOW', status: purchase.status })]);
    expect(s.paypal.calls.map((call) => call.method)).toContain('chargeSavedWallet');
    expect(s.fake.requests).toHaveLength(1);
    expect(s.events.map((event) => event.type)).toEqual(['status', 'tool', 'proposal']);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('never runs a proposal the model makes after the buyer has left', async () => {
    const buyerLeaves = new AbortController();
    const fake = fakeClaude([messageJson({ toolUses: [proposeCall] }), messageJson({ text: SUMMARY })]);
    const leavesWhileAsking: typeof fetch = async (input, init) => {
      buyerLeaves.abort();
      return fake.fetch(input, init);
    };
    const s = await setUp([], { claude: new Anthropic({ apiKey: 'test', fetch: leavesWhileAsking, maxRetries: 0 }) });

    const result = await s.run(buyerLeaves.signal);

    expect(result.outcomes).toEqual([]);
    expect(await s.db.select().from(purchases)).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
    expect(await s.db.select().from(llmCalls)).toHaveLength(1);
    expect(s.events).toEqual([STARTED]);
  });

  it('stores what the agent looked at, chose and why with the purchase, and its receipt signs the hash', async () => {
    const search = vi.fn<MarketSearch>(async () => [{ title: 'Turmeric 100g', medianPriceCents: 500, offers: [{ priceCents: 480 }] }]);
    const marketCall = { id: 'toolu_market', name: 'search_market', input: { query: 'turmeric 100g' } };
    const s = await setUp(
      [
        messageJson({ toolUses: [searchCall('toolu_search')] }),
        messageJson({ toolUses: [marketCall] }),
        messageJson({ toolUses: [proposeCall] }),
        messageJson({ text: SUMMARY }),
      ],
      { search },
    );

    const { runId } = await s.run();

    const [purchase] = await s.db.select().from(purchases);
    expect(purchase.decisionRecord).toEqual({
      v: 1,
      runId,
      steps: [
        {
          tool: 'search_sellers',
          input: { query: 'turmeric' },
          listings: [{ sellerSlug: 'ravi-spices', sku: 'TUR-100', priceCents: 450, stock: 40, titleHash: sha256Hex('Turmeric powder 100g') }],
        },
        {
          tool: 'search_market',
          input: { query: 'turmeric 100g' },
          results: [{ titleHash: sha256Hex('Turmeric 100g'), medianPriceCents: 500, cheapestCents: 480 }],
        },
      ],
      choice: { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 1 }] },
      rationale: RATIONALE,
    });
    const [receipt] = await s.db.select().from(receipts);
    expect(decodeJwt(receipt.jws).agent).toEqual({ decisionHash: hashOf(purchase.decisionRecord) });
    expect(JSON.stringify(purchase.decisionRecord)).not.toMatch(/Turmeric powder|Spice Co/);
  });

  it('snapshots the record at each proposal, so a later one also holds what the agent looked at since', async () => {
    const lookup = { id: 'toolu_lookup', name: 'get_product', input: { sellerSlug: SEEDED_SELLER.slug, sku: 'GAR-200' } };
    const second = {
      id: 'toolu_propose_2',
      name: 'propose_purchase',
      input: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'GAR-200', quantity: 1 }], rationale: 'Garam masala too.' },
    };
    const s = await setUp([
      messageJson({ toolUses: [searchCall('toolu_search')] }),
      messageJson({ toolUses: [proposeCall] }),
      messageJson({ toolUses: [lookup] }),
      messageJson({ toolUses: [second] }),
      messageJson({ text: SUMMARY }),
    ]);

    await s.run();

    const [first, later] = await s.db.select().from(purchases).orderBy(asc(purchases.createdAt), asc(purchases.id));
    const records = [first, later].map((purchase) => purchase.decisionRecord!);
    records.sort((a, b) => a.steps.length - b.steps.length);
    expect(records[0].steps.map((step) => step.tool)).toEqual(['search_sellers']);
    expect(records[0].choice.items).toEqual([{ sku: 'TUR-100', quantity: 1 }]);
    expect(records[1].steps.map((step) => step.tool)).toEqual(['search_sellers', 'get_product']);
    expect(records[1]).toMatchObject({ choice: { items: [{ sku: 'GAR-200', quantity: 1 }] }, rationale: 'Garam masala too.' });
  });

  it('gives the agent the market search it is handed', async () => {
    const search = vi.fn<MarketSearch>(async () => [{ title: 'Turmeric 100g', medianPriceCents: 500, offers: [{ priceCents: 480 }] }]);
    const marketCall = { id: 'toolu_market', name: 'search_market', input: { query: 'turmeric 100g' } };
    const s = await setUp([messageJson({ toolUses: [marketCall] }), messageJson({ text: SUMMARY })], { search });

    await s.run();

    expect(search).toHaveBeenCalledExactlyOnceWith('turmeric 100g');
  });

  it('plays a search and one proposal of the demo turmeric from the recorded run when LLM_STUB=1', async () => {
    vi.stubEnv('LLM_STUB', '1');
    const s = await setUp([], { claude: createClaude() });

    const result = await s.run();

    const [purchase] = await s.db.select().from(purchases);
    expect(purchase).toMatchObject({ request: REQUEST, runId: result.runId });
    expect(s.events).toEqual([
      STARTED,
      { type: 'tool', name: 'search_sellers', input: { query: 'turmeric' } },
      {
        type: 'tool',
        name: 'propose_purchase',
        input: { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 1 }], rationale: expect.any(String) },
      },
      { type: 'proposal', outcome: expect.objectContaining({ purchaseId: purchase.id, verdict: 'ALLOW' }) },
      { type: 'done', summary: expect.stringContaining('LLM_STUB is set') },
    ]);
  });
});
