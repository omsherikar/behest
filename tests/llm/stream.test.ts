import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { llmCalls } from '@/lib/db/schema';
import { createClaude, recordCall } from '@/lib/llm/client';
import { type LlmStreamEvent, streamReply } from '@/lib/llm/stream';
import { fakeClaude } from '@/tests/helpers/fake-claude';
import { recordedStream, sseBody, sseEvents, streamReply as streamed } from '@/tests/helpers/sse';
import { createTestDb } from '@/tests/helpers/test-db';

const NOW = new Date('2026-11-06T12:00:00Z');

const messages: BetaMessageParam[] = [{ role: 'user', content: 'Which purchases needed approval this week and why?' }];
const tools: BetaTool[] = [
  {
    name: 'execute_query',
    description: 'Run a query over the data.',
    input_schema: { type: 'object', properties: { query: { type: 'object' } }, required: ['query'] },
  },
];
const request = { system: 'You are the dashboard analyst.', messages, tools };

// One database for the file, emptied after each test. The first createTestDb() in a file migrates
// the template database, which is slow on a busy machine.
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
}, 30_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(llmCalls);
});

async function setup(responses: object[]) {
  const fake = fakeClaude(responses);
  const claude = new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries: 0 });
  const deps = { db, claude, now: () => NOW, env: { NODE_ENV: 'test' as const } };
  return { fake, stream: () => streamReply(deps, 'studio_analyst', request) };
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const collected: LlmStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

it('passes the reply on event by event and logs one call with cost', async () => {
  const recorded = recordedStream('text-turn');
  const { stream } = await setup([streamed(recorded)]);

  const events = await collect(stream());

  expect(events).toEqual(sseEvents(recorded));
  expect(await db.select().from(llmCalls)).toEqual([
    {
      id: expect.any(String),
      route: 'studio_analyst',
      model: 'claude-opus-5-5',
      effort: 'low',
      inputTokens: 1800,
      outputTokens: 62,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.00844,
      stopReason: 'end_turn',
      requestId: 'req_fake_1',
      latencyMs: 0,
      ok: true,
      error: null,
      createdAt: NOW,
    },
  ]);
});

it("sends the route's model and effort, the tools, summarized thinking, caching and fallbacks", async () => {
  const { fake, stream } = await setup([streamed(recordedStream('text-turn'))]);

  await collect(stream());

  const [sent] = fake.requests;
  expect(new URL(sent.url).pathname).toBe('/v1/messages');
  expect(sent.body).toEqual({
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    system: 'You are the dashboard analyst.',
    messages,
    tools,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'low' },
    cache_control: { type: 'ephemeral' },
    fallbacks: 'default',
    stream: true,
  });
  expect(sent.headers['anthropic-beta'].split(',')).toEqual(['server-side-fallback-2026-07-01']);
  expect(sent.headers['x-behest-route']).toBe('studio_analyst');
});

it('passes message_start on as the API sent it, before the rest of the reply fills it in', async () => {
  const { stream } = await setup([streamed(recordedStream('tool-turn'))]);

  const [start] = await collect(stream());

  expect(start).toEqual(sseEvents(recordedStream('tool-turn'))[0]);
  expect(start).toMatchObject({ type: 'message_start', message: { content: [], usage: { output_tokens: 2 } } });
});

it('sends nothing and ends with a spend_cap error once the daily cap is reached', async () => {
  const { fake, stream } = await setup([]);
  await recordCall(db, { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 5, createdAt: NOW });

  const events = await collect(stream());

  expect(events).toEqual([
    { type: 'error', error: { type: 'spend_cap', message: 'Spent $5 of the $5 daily model budget' } },
  ]);
  expect(fake.requests).toHaveLength(0);
  expect(await db.select().from(llmCalls)).toHaveLength(1);
});

it('ends a stream that fails part way with an api_error event and logs what it spent', async () => {
  const recorded = recordedStream('error-turn');
  const { stream } = await setup([streamed(recorded)]);

  const events = await collect(stream());

  expect(events).toEqual([
    ...sseEvents(recorded).slice(0, -1),
    { type: 'error', error: { type: 'api_error', message: expect.stringContaining('Overloaded') } },
  ]);
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({
      route: 'studio_analyst',
      model: 'claude-opus-5-5',
      inputTokens: 1500,
      outputTokens: 3,
      costUsd: 0.00606,
      requestId: 'req_fake_1',
      stopReason: null,
      ok: false,
      error: expect.stringMatching(/^api_error: .*Overloaded/),
    }),
  ]);
});

it('ends with an api_error event when the request is refused outright, and logs the call', async () => {
  const { stream } = await setup([
    { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]);

  const events = await collect(stream());

  expect(events).toEqual([{ type: 'error', error: { type: 'api_error', message: expect.stringContaining('Overloaded') } }]);
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ inputTokens: 0, outputTokens: 0, costUsd: 0, requestId: 'req_fake_1', ok: false }),
  ]);
});

it('logs a refused reply as a failed call and leaves the refusal in the events', async () => {
  const refused = sseBody([
    ...sseEvents(recordedStream('text-turn')).slice(0, -2),
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_sequence: null,
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'The request was declined.' },
      },
      usage: { output_tokens: 10 },
    },
    { type: 'message_stop' },
  ] as { type: string }[]);
  const { stream } = await setup([streamed(refused)]);

  const events = await collect(stream());

  expect(events.at(-2)).toMatchObject({ type: 'message_delta', delta: { stop_reason: 'refusal' } });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ stopReason: 'refusal', ok: false, error: 'refusal: The request was declined.' }),
  ]);
});

it('cancels the request and logs it when the reader stops early', async () => {
  const { stream } = await setup([streamed(recordedStream('text-turn'))]);

  const events = stream();
  const first = await events.next();
  await events.return();

  expect(first.value).toMatchObject({ type: 'message_start' });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({
      inputTokens: 1800,
      ok: false,
      error: 'api_error: The reader stopped before the reply ended',
    }),
  ]);
});

it('replays the recorded stream of the route when LLM_STUB=1', async () => {
  vi.stubEnv('LLM_STUB', '1');
  const deps = { db, claude: createClaude(), now: () => NOW, env: { NODE_ENV: 'test' as const } };

  const events = await collect(streamReply(deps, 'studio_analyst', request));

  expect(events).toEqual(sseEvents(recordedStream('stub')));
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ route: 'studio_analyst', ok: true, requestId: 'stub', costUsd: 0 }),
  ]);
});

it('ends with an api_error event for a route without a recorded stream when LLM_STUB=1', async () => {
  vi.stubEnv('LLM_STUB', '1');
  const deps = { db, claude: createClaude(), now: () => NOW, env: { NODE_ENV: 'test' as const } };

  expect(await collect(streamReply(deps, 'intent_check', request))).toEqual([
    {
      type: 'error',
      error: { type: 'api_error', message: expect.stringContaining('tests/fixtures/llm/intent_check/stub.sse') },
    },
  ]);
});
