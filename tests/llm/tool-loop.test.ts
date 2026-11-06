import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { llmCalls } from '@/lib/db/schema';
import { recordCall } from '@/lib/llm/client';
import { runToolLoop } from '@/lib/llm/tool-loop';
import { fakeClaude, iteration, messageJson } from '@/tests/helpers/fake-claude';
import { createTestDb } from '@/tests/helpers/test-db';

const NOW = new Date('2026-11-06T12:00:00Z');

const messages: BetaMessageParam[] = [{ role: 'user', content: 'Find turmeric under $10.' }];
const searchCall = { id: 'toolu_1', name: 'search_catalog', input: { query: 'turmeric' } };

const SERVER_ERROR = {
  status: 500,
  headers: { 'retry-after-ms': '0' },
  body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
};

type Loop = Parameters<typeof runToolLoop>[2];

async function setup(
  responses: object[],
  { env = {}, maxRetries = 0 }: { env?: Record<string, string>; maxRetries?: number } = {},
) {
  const db = await createTestDb();
  const fake = fakeClaude(responses);
  const claude = new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries });
  const deps = { db, claude, now: () => NOW, env: { NODE_ENV: 'test' as const, ...env } };
  const run = vi.fn(async ({ query }: { query: string }) => `Turmeric, 100g, $4 (searched for ${query})`);
  const search = betaZodTool({
    name: 'search_catalog',
    description: 'Search the catalog for products.',
    inputSchema: z.object({ query: z.string() }),
    strict: true,
    run,
  });
  const loop = (overrides: Partial<Loop> = {}) =>
    runToolLoop(deps, 'shopping_agent', {
      system: 'Find what the buyer asked for.',
      messages,
      tools: [search],
      maxTurns: 4,
      ...overrides,
    });
  return { db, fake, deps, run, search, loop };
}

it('runs a tool between two turns and logs a call for each turn', async () => {
  const { db, fake, run, loop } = await setup([
    messageJson({ toolUses: [searchCall], usage: { input_tokens: 1000, output_tokens: 100 } }),
    messageJson({ text: 'Turmeric, 100g, $4.', usage: { input_tokens: 1200, output_tokens: 50 } }),
  ]);

  const result = await loop();

  const rows = await db.select().from(llmCalls);
  expect(result).toEqual({
    ok: true,
    value: expect.objectContaining({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Turmeric, 100g, $4.', citations: null }],
    }),
    callId: rows[1].id,
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][0]).toEqual({ query: 'turmeric' });
  expect(fake.requests[1].body.messages).toEqual([
    ...messages,
    { role: 'assistant', content: [{ type: 'tool_use', ...searchCall }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Turmeric, 100g, $4 (searched for turmeric)' },
      ],
    },
  ]);
  const turn = {
    route: 'shopping_agent',
    model: 'claude-opus-5-5',
    effort: 'medium',
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 0,
    ok: true,
    error: null,
    createdAt: NOW,
  };
  expect(rows).toEqual([
    {
      ...turn,
      id: expect.any(String),
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: 0.006,
      stopReason: 'tool_use',
      requestId: 'req_fake_1',
    },
    {
      ...turn,
      id: result.callId,
      inputTokens: 1200,
      outputTokens: 50,
      costUsd: 0.0058,
      stopReason: 'end_turn',
      requestId: 'req_fake_2',
    },
  ]);
});

it('sends the route model, effort, fallbacks and strict tools on every turn and nothing else', async () => {
  const { fake, loop } = await setup([messageJson({ toolUses: [searchCall] }), messageJson({ text: 'Done.' })]);

  await loop();

  expect(fake.requests).toHaveLength(2);
  for (const { url, headers, body } of fake.requests) {
    expect(new URL(url).pathname).toBe('/v1/messages');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: 'Find what the buyer asked for.',
      fallbacks: 'default',
      tools: [
        {
          name: 'search_catalog',
          description: 'Search the catalog for products.',
          strict: true,
          input_schema: expect.objectContaining({ type: 'object', required: ['query'] }),
        },
      ],
    });
    expect(body.output_config).toEqual({ effort: 'medium' });
    for (const key of ['tool_choice', 'temperature', 'top_p', 'top_k', 'thinking', 'thread', 'max_iterations']) {
      expect(body).not.toHaveProperty(key);
    }
    expect(headers['anthropic-beta'].split(',')).toEqual(['server-side-fallback-2026-07-01']);
    expect(headers['x-behest-route']).toBe('shopping_agent');
  }
});

it('stops after maxTurns requests and returns the last reply', async () => {
  const { db, fake, run, loop } = await setup([messageJson({ toolUses: [searchCall] }), messageJson({ text: 'Done.' })]);

  const result = await loop({ maxTurns: 1 });

  expect(result).toMatchObject({ ok: true, value: { stop_reason: 'tool_use' } });
  expect(fake.requests).toHaveLength(1);
  expect(await db.select().from(llmCalls)).toHaveLength(1);
  // The calls of the last turn still run; the model never sees their results.
  expect(run).toHaveBeenCalledTimes(1);
});

it('returns spend_cap once a turn reaches the cap, before running its tools, and keeps the turns logged', async () => {
  const { db, fake, run, loop } = await setup(
    [
      messageJson({ toolUses: [searchCall], usage: { input_tokens: 1000, output_tokens: 500 } }),
      messageJson({ text: 'Done.' }),
    ],
    { env: { LLM_DAILY_CAP_USD: '0.01' } },
  );

  const result = await loop();

  expect(result).toEqual({
    ok: false,
    error: 'spend_cap',
    callId: null,
    detail: 'Spent $0.014 of the $0.01 daily model budget',
  });
  expect(fake.requests).toHaveLength(1);
  expect(run).not.toHaveBeenCalled();
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ ok: true, stopReason: 'tool_use', costUsd: 0.014 }),
  ]);
});

it('refuses to start once the daily cap is spent', async () => {
  const { db, fake, loop } = await setup([messageJson({ text: 'Done.' })]);
  await recordCall(db, { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 5, createdAt: NOW });

  expect(await loop()).toEqual({
    ok: false,
    error: 'spend_cap',
    callId: null,
    detail: 'Spent $5 of the $5 daily model budget',
  });
  expect(fake.requests).toHaveLength(0);
  expect(await db.select().from(llmCalls)).toHaveLength(1);
});

it('sends a tool that throws to the model as an is_error result and carries on', async () => {
  const { fake, run, loop } = await setup([messageJson({ toolUses: [searchCall] }), messageJson({ text: 'Done.' })]);
  run.mockRejectedValueOnce(new Error('The catalog is unavailable'));

  const result = await loop();

  expect(result).toMatchObject({ ok: true, value: { stop_reason: 'end_turn' } });
  expect(fake.requests[1].body.messages).toContainEqual({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Error: The catalog is unavailable', is_error: true },
    ],
  });
});

it('maps a refusal after a tool turn to refusal and logs both turns', async () => {
  const { db, loop } = await setup([messageJson({ toolUses: [searchCall] }), messageJson({ stop_reason: 'refusal' })]);

  const result = await loop();

  const rows = await db.select().from(llmCalls);
  expect(result).toEqual({ ok: false, error: 'refusal', callId: rows[1].id, detail: 'The request was declined.' });
  expect(rows.map((row) => [row.ok, row.stopReason, row.error])).toEqual([
    [true, 'tool_use', null],
    [false, 'refusal', 'refusal: The request was declined.'],
  ]);
});

it('maps a cut-off turn to max_tokens without running its tool calls', async () => {
  const { db, run, loop } = await setup([
    messageJson({ toolUses: [searchCall], stop_reason: 'max_tokens' }),
    messageJson({ text: 'Turmeric', stop_reason: 'model_context_window_exceeded' }),
  ]);

  const cutOff = await loop();
  const overflowed = await loop();

  expect(cutOff).toMatchObject({ ok: false, error: 'max_tokens', detail: 'The reply stopped with max_tokens' });
  expect(overflowed).toMatchObject({
    ok: false,
    error: 'max_tokens',
    detail: 'The reply stopped with model_context_window_exceeded',
  });
  expect(run).not.toHaveBeenCalled();
  expect((await db.select().from(llmCalls)).map((row) => [row.ok, row.error?.split(':')[0]])).toEqual([
    [false, 'max_tokens'],
    [false, 'max_tokens'],
  ]);
});

it('maps a failed request to api_error and logs it after the turns before it', async () => {
  const { db, loop } = await setup([messageJson({ toolUses: [searchCall] }), SERVER_ERROR]);

  const result = await loop();

  const rows = await db.select().from(llmCalls);
  expect(result).toEqual({
    ok: false,
    error: 'api_error',
    callId: rows[1].id,
    detail: expect.stringContaining('500'),
  });
  expect(rows).toEqual([
    expect.objectContaining({ ok: true, requestId: 'req_fake_1' }),
    expect.objectContaining({
      ok: false,
      stopReason: null,
      requestId: 'req_fake_2',
      costUsd: 0,
      error: expect.stringMatching(/^api_error: 500/),
    }),
  ]);
});

it('maps a network failure to api_error and logs it', async () => {
  const { db, fake, loop } = await setup([]);

  const result = await loop();

  expect(fake.requests).toHaveLength(1);
  expect(result).toEqual({ ok: false, error: 'api_error', callId: expect.any(String), detail: expect.any(String) });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ id: result.callId, ok: false, requestId: null, error: expect.stringMatching(/^api_error: /) }),
  ]);
});

it('maps a response that is not a message, or whose usage cannot be priced, to api_error', async () => {
  const { db, loop } = await setup([
    { status: 200, text: '<!doctype html><title>Gateway</title>', headers: { 'content-type': 'text/html' } },
    {},
    { ...messageJson({ toolUses: [searchCall] }), usage: { input_tokens: 1, output_tokens: 1, iterations: [null] } },
  ]);

  const results = [await loop(), await loop(), await loop()];

  for (const result of results) {
    expect(result).toEqual({ ok: false, error: 'api_error', callId: expect.any(String), detail: expect.any(String) });
  }
  const rows = await db.select().from(llmCalls);
  expect(rows.map((row) => [row.ok, row.requestId, row.error?.split(':')[0]])).toEqual([
    [false, 'req_fake_1', 'api_error'],
    [false, 'req_fake_2', 'api_error'],
    [false, 'req_fake_3', 'api_error'],
  ]);
});

it('prices each turn by its fallback hops and logs the model that served it', async () => {
  const { db, loop } = await setup([
    messageJson({
      fallbackFrom: { model: 'claude-opus-5-5' },
      model: 'claude-opus-4-8',
      toolUses: [searchCall],
      usage: {
        input_tokens: 1000,
        output_tokens: 500,
        iterations: [
          iteration('message', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }),
          iteration('fallback_message', 'claude-opus-4-8', { input_tokens: 1000, output_tokens: 500 }),
        ],
      },
    }),
    messageJson({ text: 'Done.', model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 0 } }),
  ]);

  expect(await loop()).toMatchObject({ ok: true });
  // claude-opus-5-5: 1000 x $4 + 100 x $20 per million = $0.006. claude-opus-4-8: 1000 x $5 + 500 x $25 = $0.0175.
  expect((await db.select().from(llmCalls)).map((row) => [row.model, row.inputTokens, row.costUsd])).toEqual([
    ['claude-opus-4-8', 2000, 0.0235],
    ['claude-opus-4-8', 1000, 0.005],
  ]);
});

it('logs how long each request took, leaving out the time its tools ran', async () => {
  let now = NOW;
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const { db, deps, run, search } = await setup([]);
  const fake = fakeClaude([messageJson({ toolUses: [searchCall] }), messageJson({ text: 'Done.' })]);
  const slowFetch: typeof fetch = async (input, init) => {
    advance(300);
    return fake.fetch(input, init);
  };
  run.mockImplementationOnce(async () => {
    advance(5000);
    return 'Turmeric, 100g, $4';
  });
  const claude = new Anthropic({ apiKey: 'test', fetch: slowFetch, maxRetries: 0 });

  await runToolLoop({ ...deps, claude, now: () => now }, 'shopping_agent', {
    system: 'Find what the buyer asked for.',
    messages,
    tools: [search],
    maxTurns: 4,
  });

  expect((await db.select().from(llmCalls)).map((row) => [row.latencyMs, row.createdAt])).toEqual([
    [300, new Date(NOW.getTime() + 300)],
    [300, new Date(NOW.getTime() + 5600)],
  ]);
});

it('hands each reply to onMessage as it arrives', async () => {
  const { loop } = await setup([messageJson({ toolUses: [searchCall] }), messageJson({ text: 'Done.' })]);
  const onMessage = vi.fn();

  await loop({ onMessage });

  expect(onMessage.mock.calls.map(([message]) => message.stop_reason)).toEqual(['tool_use', 'end_turn']);
});

it('refuses a maxTurns that is not a whole number of turns, 1 or more', async () => {
  const { fake, loop } = await setup([]);

  for (const maxTurns of [0, -1, 1.5, Number.NaN]) {
    await expect(loop({ maxTurns })).rejects.toThrow('maxTurns must be a whole number of turns, 1 or more');
  }
  expect(fake.requests).toHaveLength(0);
});

it('refuses a tool that does not set strict', async () => {
  const { fake, loop } = await setup([]);
  const loose = betaZodTool({
    name: 'loose_lookup',
    description: 'Look something up.',
    inputSchema: z.object({ id: z.string() }),
    run: async () => 'found',
  });

  await expect(loop({ tools: [loose] })).rejects.toThrow('Every tool must set strict: true; loose_lookup does not');
  expect(fake.requests).toHaveLength(0);
});
