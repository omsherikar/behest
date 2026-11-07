import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { llmCalls } from '@/lib/db/schema';
import { createClaude, recordCall } from '@/lib/llm/client';
import { LLM_ROUTES, type LlmRoute } from '@/lib/llm/routes';
import { billedUsage, callStructured } from '@/lib/llm/structured';
import { fakeClaude, iteration, messageJson } from '@/tests/helpers/fake-claude';
import { createTestDb } from '@/tests/helpers/test-db';

const NOW = new Date('2026-11-06T12:00:00Z');

const Answer = z.object({ answer: z.string() });
const messages: BetaMessageParam[] = [{ role: 'user', content: 'Is turmeric a spice?' }];
const request = { system: 'Answer in one word.', messages, schema: Answer };

const SERVER_ERROR = {
  status: 500,
  // Lets the SDK retry at once instead of backing off.
  headers: { 'retry-after-ms': '0' },
  body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup(
  responses: object[],
  { env = {}, maxRetries = 0 }: { env?: Record<string, string>; maxRetries?: number } = {},
) {
  const db = await createTestDb();
  const fake = fakeClaude(responses);
  const claude = new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries });
  const deps = { db, claude, now: () => NOW, env: { NODE_ENV: 'test' as const, ...env } };
  return { db, fake, deps, call: (route: LlmRoute = 'mandate_compile') => callStructured(deps, route, request) };
}

it('returns parsed output and logs one call with cost', async () => {
  const { db, call } = await setup([
    messageJson({ json: { answer: 'yes' }, usage: { input_tokens: 1000, output_tokens: 500 } }),
  ]);

  const result = await call();

  expect(result).toEqual({ ok: true, value: { answer: 'yes' }, callId: expect.any(String) });
  expect(await db.select().from(llmCalls)).toEqual([
    {
      id: result.callId,
      route: 'mandate_compile',
      model: 'claude-opus-5-5',
      effort: 'medium',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.014,
      stopReason: 'end_turn',
      requestId: 'req_fake_1',
      latencyMs: 0,
      ok: true,
      error: null,
      createdAt: NOW,
    },
  ]);
});

it('sends model, effort, fallbacks and the fallback beta', async () => {
  const { fake, call } = await setup([messageJson({ json: { answer: 'yes' } })]);

  await call();

  const [sent] = fake.requests;
  expect(new URL(sent.url).pathname).toBe('/v1/messages');
  expect(sent.body).toMatchObject({
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    system: [{ type: 'text', text: 'Answer in one word.' }],
    messages,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: expect.any(Object) } },
    fallbacks: 'default',
  });
  expect(sent.headers['anthropic-beta'].split(',')).toContain('server-side-fallback-2026-07-01');
  expect(sent.headers['x-behest-route']).toBe('mandate_compile');
});

it('marks the system prompt for caching, so the prefix every request shares is read back', async () => {
  const { fake, call } = await setup([messageJson({ json: { answer: 'yes' } })]);

  await call();

  const [{ body }] = fake.requests;
  expect(body.system).toEqual([{ type: 'text', text: 'Answer in one word.', cache_control: { type: 'ephemeral' } }]);
  // A top-level marker would land on the user message, which differs every time and is never read back.
  expect(body).not.toHaveProperty('cache_control');
});

it('never sends tool_choice, temperature or disabled thinking', async () => {
  const { fake, call } = await setup(LLM_ROUTES.map(() => messageJson({ json: { answer: 'yes' } })));

  for (const route of LLM_ROUTES) await call(route);

  expect(fake.requests).toHaveLength(LLM_ROUTES.length);
  for (const { body } of fake.requests) {
    for (const key of ['tool_choice', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(key);
    expect(body).not.toHaveProperty('thinking');
  }
});

it('maps a refusal to error refusal', async () => {
  const { db, call } = await setup([
    messageJson({ text: '{"answer": "y', stop_reason: 'refusal', usage: { input_tokens: 100, output_tokens: 3 } }),
  ]);

  const result = await call();

  expect(result).toEqual({
    ok: false,
    error: 'refusal',
    callId: expect.any(String),
    detail: 'The request was declined.',
  });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({
      id: result.callId,
      ok: false,
      stopReason: 'refusal',
      error: 'refusal: The request was declined.',
      costUsd: 0.00046,
    }),
  ]);
});

it('maps max_tokens to error max_tokens', async () => {
  const { db, call } = await setup([messageJson({ text: '{"answer": "y', stop_reason: 'max_tokens' })]);

  const result = await call();

  expect(result).toMatchObject({ ok: false, error: 'max_tokens', callId: expect.any(String) });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ ok: false, stopReason: 'max_tokens', error: expect.stringMatching(/^max_tokens/) }),
  ]);
});

it('maps model_context_window_exceeded to error max_tokens', async () => {
  const { call } = await setup([messageJson({ text: '{"answer": "y', stop_reason: 'model_context_window_exceeded' })]);

  expect(await call()).toMatchObject({
    ok: false,
    error: 'max_tokens',
    detail: 'The reply stopped with model_context_window_exceeded',
  });
});

it('maps schema-invalid output to invalid_output', async () => {
  const { db, call } = await setup([
    messageJson({ json: { answer: 42 } }),
    messageJson({ text: 'Yes, it is.' }),
    messageJson(),
  ]);

  const wrongType = await call();
  const notJson = await call();
  const noText = await call();

  expect(wrongType).toMatchObject({ ok: false, error: 'invalid_output', detail: expect.stringContaining('answer') });
  expect(notJson).toMatchObject({ ok: false, error: 'invalid_output', detail: 'The reply was not JSON' });
  expect(noText).toMatchObject({ ok: false, error: 'invalid_output', detail: 'The reply had no text' });
  const rows = await db.select().from(llmCalls);
  expect(rows.map((row) => [row.ok, row.error?.split(':')[0]])).toEqual([
    [false, 'invalid_output'],
    [false, 'invalid_output'],
    [false, 'invalid_output'],
  ]);
});

it('treats a reply that did not end its turn as invalid output', async () => {
  const { call } = await setup([messageJson({ json: { answer: 'yes' }, stop_reason: 'pause_turn' })]);

  expect(await call()).toMatchObject({
    ok: false,
    error: 'invalid_output',
    detail: 'The reply stopped with pause_turn',
  });
});

it('throws before sending anything when the schema has no JSON Schema form', async () => {
  const { db, fake, deps } = await setup([messageJson({ json: { answer: 'yes' } })]);
  const Dated = z.object({ on: z.date() });

  await expect(callStructured(deps, 'mandate_compile', { ...request, schema: Dated })).rejects.toThrow(
    'Date cannot be represented in JSON Schema',
  );
  expect(fake.requests).toHaveLength(0);
  expect(await db.select().from(llmCalls)).toHaveLength(0);
});

it('refuses to call once the daily cap is spent', async () => {
  const { db, fake, call } = await setup([messageJson({ json: { answer: 'yes' } })]);
  await recordCall(db, { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 5, createdAt: NOW });

  const result = await call();

  expect(result).toEqual({
    ok: false,
    error: 'spend_cap',
    callId: null,
    detail: 'Spent $5 of the $5 daily model budget',
  });
  expect(fake.requests).toHaveLength(0);
  expect(await db.select().from(llmCalls)).toHaveLength(1);
});

it('calls while spending is under the cap', async () => {
  const { db, call } = await setup([messageJson({ json: { answer: 'yes' } })], { env: { LLM_DAILY_CAP_USD: '0.5' } });
  await recordCall(db, { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 0.49, createdAt: NOW });

  expect(await call()).toMatchObject({ ok: true });
});

it("still compiles mandates once the analyst's own daily cap is spent", async () => {
  const { db, fake, call } = await setup([messageJson({ json: { answer: 'yes' } })]);
  await recordCall(db, { route: 'studio_analyst', model: 'claude-opus-5-5', effort: 'low', ok: true, costUsd: 1, createdAt: NOW });

  expect(await call('mandate_compile')).toMatchObject({ ok: true });
  expect(fake.requests).toHaveLength(1);
});

it("refuses the catalog builder once its own daily cap is spent, under the overall cap", async () => {
  const { db, fake, call } = await setup([messageJson({ json: { answer: 'yes' } })]);
  await recordCall(db, { route: 'catalog_build', model: 'claude-opus-5-5', effort: 'medium', ok: true, costUsd: 1, createdAt: NOW });

  expect(await call('catalog_build')).toEqual({
    ok: false,
    error: 'spend_cap',
    callId: null,
    detail: 'Spent $1 of the $1 daily model budget for catalog_build',
  });
  expect(fake.requests).toHaveLength(0);
});

it('maps an HTTP 500 after retries to api_error', async () => {
  const { db, fake, call } = await setup([SERVER_ERROR, SERVER_ERROR, SERVER_ERROR], { maxRetries: 2 });

  const result = await call();

  expect(fake.requests).toHaveLength(3);
  expect(result).toEqual({
    ok: false,
    error: 'api_error',
    callId: expect.any(String),
    detail: expect.stringContaining('500'),
  });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({
      id: result.callId,
      ok: false,
      stopReason: null,
      requestId: 'req_fake_3',
      costUsd: 0,
      error: expect.stringMatching(/^api_error: 500/),
    }),
  ]);
});

it('maps a network failure to api_error and logs it', async () => {
  const { db, fake, call } = await setup([]);

  const result = await call();

  expect(fake.requests).toHaveLength(1);
  expect(result).toEqual({ ok: false, error: 'api_error', callId: expect.any(String), detail: expect.any(String) });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ id: result.callId, ok: false, requestId: null, error: expect.stringMatching(/^api_error: /) }),
  ]);
});

it('maps a successful response that is not a message to api_error and logs it', async () => {
  const { db, call } = await setup([
    { status: 200, text: '<!doctype html><title>Gateway</title>', headers: { 'content-type': 'text/html' } },
    {},
    { content: [] },
    { ...messageJson({ json: { answer: 'yes' }, usage: { input_tokens: 1000, output_tokens: 500 } }), content: null },
  ]);

  const results = [await call(), await call(), await call(), await call()];

  for (const result of results) {
    expect(result).toEqual({ ok: false, error: 'api_error', callId: expect.any(String), detail: expect.any(String) });
  }
  // The SDK's parse rejects a reply without content before handing it over, so its usage cannot be read.
  const rows = await db.select().from(llmCalls);
  expect(rows.map((row) => [row.ok, row.requestId, row.costUsd, row.error?.split(':')[0]])).toEqual([
    [false, 'req_fake_1', 0, 'api_error'],
    [false, 'req_fake_2', 0, 'api_error'],
    [false, 'req_fake_3', 0, 'api_error'],
    [false, 'req_fake_4', 0, 'api_error'],
  ]);
});

it('maps malformed usage iterations to api_error, charging top-level counts at the highest rates', async () => {
  const withIterations = (iterations: unknown, inputTokens = 10) => ({
    ...messageJson({ json: { answer: 'yes' } }),
    usage: { input_tokens: inputTokens, output_tokens: 5, iterations },
  });
  const { db, call } = await setup([
    withIterations([null]),
    withIterations([{ type: 'message', model: 'claude-opus-5-5' }]),
    withIterations('all of them'),
    withIterations([null], -1),
  ]);

  const results = [await call(), await call(), await call(), await call()];

  for (const result of results) {
    expect(result).toEqual({ ok: false, error: 'api_error', callId: expect.any(String), detail: expect.any(String) });
  }
  // 10 x $10 + 5 x $50 per million at the highest rates. Top-level counts that are not counts are not charged.
  const rows = await db.select().from(llmCalls);
  expect(rows.map((row) => [row.ok, row.requestId, row.inputTokens, row.costUsd, row.error?.split(':')[0]])).toEqual([
    [false, 'req_fake_1', 10, 0.00035, 'api_error'],
    [false, 'req_fake_2', 10, 0.00035, 'api_error'],
    [false, 'req_fake_3', 10, 0.00035, 'api_error'],
    [false, 'req_fake_4', 0, 0, 'api_error'],
  ]);
});

it('honours CLAUDE_MODEL_ and CLAUDE_EFFORT_ overrides', async () => {
  const { db, fake, call } = await setup(
    [
      messageJson({
        json: { answer: 'yes' },
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 1000, output_tokens: 500 },
      }),
    ],
    { env: { CLAUDE_MODEL_MANDATE_COMPILE: 'claude-sonnet-5-5', CLAUDE_EFFORT_MANDATE_COMPILE: 'low' } },
  );

  await call();

  expect(fake.requests[0].body).toMatchObject({ model: 'claude-sonnet-5-5', output_config: { effort: 'low' } });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'low', costUsd: 0.007 }),
  ]);
});

it('continues an answer the declining model started before a fallback', async () => {
  const { call } = await setup([
    messageJson({
      fallbackFrom: { model: 'claude-opus-5-5', text: '{"answer": ' },
      model: 'claude-opus-4-8',
      text: '"yes"}',
    }),
  ]);

  expect(await call()).toMatchObject({ ok: true, value: { answer: 'yes' } });
});

it('takes a complete answer the fallback model restarts after the fallback', async () => {
  const { call } = await setup([
    messageJson({
      fallbackFrom: { model: 'claude-opus-5-5', text: '{"answer": "y' },
      model: 'claude-opus-4-8',
      json: { answer: 'no' },
    }),
  ]);

  expect(await call()).toMatchObject({ ok: true, value: { answer: 'no' } });
});

it('never accepts text from before a fallback on its own', async () => {
  const declined = { model: 'claude-opus-5-5', text: '{"answer": "yes"}' };
  const { db, call } = await setup([
    messageJson({ fallbackFrom: declined, model: 'claude-opus-4-8', text: 'Here is what I found.' }),
    messageJson({ fallbackFrom: declined, model: 'claude-opus-4-8', text: ' ' }),
    messageJson({ fallbackFrom: declined, model: 'claude-opus-4-8' }),
  ]);

  const results = [await call(), await call(), await call()];

  expect(results).toEqual([
    { ok: false, error: 'invalid_output', callId: expect.any(String), detail: 'The reply was not JSON' },
    { ok: false, error: 'invalid_output', callId: expect.any(String), detail: 'The reply had no text after the fallback' },
    { ok: false, error: 'invalid_output', callId: expect.any(String), detail: 'The reply had no text after the fallback' },
  ]);
  expect((await db.select().from(llmCalls)).map((row) => row.ok)).toEqual([false, false, false]);
});

it('prices each fallback hop at its own model and logs the model that served the reply', async () => {
  const { db, call } = await setup(
    [
      messageJson({
        fallbackFrom: { model: 'claude-sonnet-5-5' },
        model: 'claude-sonnet-5',
        json: { answer: 'yes' },
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          iterations: [
            iteration('message', 'claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 100 }),
            iteration('fallback_message', 'claude-sonnet-5', { input_tokens: 1000, output_tokens: 500 }),
          ],
        },
      }),
    ],
    { env: { CLAUDE_MODEL_MANDATE_COMPILE: 'claude-sonnet-5-5' } },
  );

  expect(await call()).toMatchObject({ ok: true, value: { answer: 'yes' } });
  // claude-sonnet-5-5 at its own rates: 1000 x $2 + 100 x $10 per million = $0.003.
  // claude-sonnet-5 has no price, so the highest rates: 1000 x $10 + 500 x $50 per million = $0.035.
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ model: 'claude-sonnet-5', inputTokens: 2000, outputTokens: 600, costUsd: 0.038 }),
  ]);
});

it('charges an attempt that names no model at the highest rates when the reply fell back', () => {
  const reply = messageJson({
    model: 'claude-opus-4-8',
    usage: {
      iterations: [
        iteration('message', null, { input_tokens: 1000, output_tokens: 100 }),
        iteration('fallback_message', 'claude-opus-4-8', { input_tokens: 1000, output_tokens: 500 }),
      ],
    },
  }) as unknown as BetaMessage;

  // The unnamed attempt may be any model in the chain, so the highest rates: 1000 x $10 + 100 x $50 per
  // million = $0.015. claude-opus-4-8 at its own rates: 1000 x $5 + 500 x $25 per million = $0.0175.
  expect(billedUsage(reply, 'claude-opus-5-5')).toMatchObject({ model: 'claude-opus-4-8', costUsd: 0.0325 });
});

it('charges an attempt that names no model at the requested rates when the reply did not fall back', () => {
  const reply = messageJson({
    usage: { iterations: [iteration('message', null, { input_tokens: 1000, output_tokens: 500 })] },
  }) as unknown as BetaMessage;

  expect(billedUsage(reply, 'claude-opus-5-5')).toMatchObject({ costUsd: 0.014 });
});

it('refuses to price usage whose token counts are not counts', () => {
  const withIterations = (iterations: object[]) =>
    ({ ...messageJson(), usage: { input_tokens: 1, output_tokens: 1, iterations } }) as unknown as BetaMessage;

  for (const reply of [
    withIterations([{ type: 'message', model: 'claude-opus-5-5' }]),
    withIterations([iteration('message', 'claude-opus-5-5', { output_tokens: -1 })]),
    withIterations([{ ...iteration('message', 'claude-opus-5-5'), cache_read_input_tokens: '7' }]),
  ]) {
    expect(() => billedUsage(reply, 'claude-opus-5-5')).toThrow('The reply reported token usage that is not a count');
  }
});

it('replays the route stub when LLM_STUB=1 and refuses to in production', async () => {
  vi.stubEnv('LLM_STUB', '1');
  const db = await createTestDb();
  const deps = { db, claude: createClaude(), now: () => NOW, env: { NODE_ENV: 'test' as const } };
  const Intent = z.object({
    verdict: z.enum(['consistent', 'needs_human', 'inconsistent']),
    reasons: z.array(z.string()),
  });

  const result = await callStructured(deps, 'intent_check', { ...request, schema: Intent });

  expect(result).toMatchObject({ ok: true, value: { verdict: 'consistent', reasons: [expect.any(String)] } });
  expect(await db.select().from(llmCalls)).toEqual([
    expect.objectContaining({ route: 'intent_check', ok: true, requestId: 'stub', costUsd: 0 }),
  ]);

  vi.stubEnv('NODE_ENV', 'production');
  expect(() => createClaude()).toThrow('LLM_STUB replays recorded replies and must not be set in production');
});

it('reports a route without a recorded reply as an API error', async () => {
  vi.stubEnv('LLM_STUB', '1');
  const db = await createTestDb();
  const deps = { db, claude: createClaude(), now: () => NOW, env: { NODE_ENV: 'test' as const } };

  expect(await callStructured(deps, 'studio_analyst', request)).toMatchObject({
    ok: false,
    error: 'api_error',
    detail: expect.stringContaining('tests/fixtures/llm/studio_analyst/stub.json'),
  });
});

it('sends real requests through the given fetch when LLM_STUB is not set', async () => {
  vi.stubEnv('LLM_STUB', '');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test');
  const db = await createTestDb();
  const fake = fakeClaude([messageJson({ json: { answer: 'yes' } })]);
  const deps = { db, claude: createClaude({ fetch: fake.fetch }), now: () => NOW, env: { NODE_ENV: 'test' as const } };

  expect(await callStructured(deps, 'mandate_compile', request)).toMatchObject({ ok: true, value: { answer: 'yes' } });
  expect(fake.requests).toHaveLength(1);
});
