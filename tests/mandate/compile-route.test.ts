import Anthropic from '@anthropic-ai/sdk';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/mandates/compile/route';
import { llmDeps } from '@/lib/app-deps';
import { confirmToken, isConfirmToken } from '@/lib/mandate/confirm-token';
import { renderReadback } from '@/lib/mandate/readback';
import { MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import demoReply from '@/tests/fixtures/llm/mandate_compile/demo.json';
import nonUsdReply from '@/tests/fixtures/llm/mandate_compile/non-usd.json';
import refusalReply from '@/tests/fixtures/llm/mandate_compile/refusal.json';
import weekendsAnsweredReply from '@/tests/fixtures/llm/mandate_compile/weekends-answered.json';
import weekendsReply from '@/tests/fixtures/llm/mandate_compile/weekends-question.json';
import { fakeClaude } from '@/tests/helpers/fake-claude';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  llmDeps: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

const SECRET = 'test-session-secret-at-least-32-characters';
const NOW = new Date('2026-11-06T12:00:00Z');
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';
const WEEKENDS_TEXT = `${TEXT}, only on weekends`;
const PER_PURCHASE_ASSUMPTION =
  'No limit was given for a single purchase, so one purchase can use the whole $60 monthly budget.';

async function request(body: unknown, { persona = 'buyer' }: { persona?: Persona | 'forged' | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
  if (persona === 'forged') headers.set('cookie', `${SESSION_COOKIE}=not-a-signed-cookie`);
  else if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest('http://localhost/api/mandates/compile', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Answers the route's calls to Claude with `replies`, on a fresh database, with `env` for the model routes and cap. */
async function claudeAnswers(replies: object[], env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }) {
  const fake = fakeClaude(replies);
  const claude = new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries: 0 });
  vi.mocked(llmDeps).mockReturnValue({ db: await createTestDb(), claude, now: () => NOW, env });
  return fake;
}

/** What the route answered, as status and JSON body. */
async function answer(response: Response) {
  return { status: response.status, body: await response.json() };
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/mandates/compile', () => {
  it('returns the policy, its readback and the assumptions, with a confirm token when no question is open', async () => {
    await claudeAnswers([demoReply]);

    const { status, body } = await answer(await POST(await request({ text: TEXT })));

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      policy: demoPolicy,
      readback: renderReadback(demoPolicy),
      assumptions: [PER_PURCHASE_ASSUMPTION],
      questions: [],
      confirmToken: confirmToken(TEXT, demoPolicy),
    });
    expect(isConfirmToken(body.confirmToken, TEXT, body.policy)).toBe(true);
  });

  it('gives no confirm token while a question is open', async () => {
    await claudeAnswers([weekendsReply]);

    const { status, body } = await answer(await POST(await request({ text: WEEKENDS_TEXT })));

    expect(status).toBe(200);
    expect(body.questions).toEqual([expect.objectContaining({ id: 'weekend_limit' })]);
    expect(body).not.toHaveProperty('confirmToken');
  });

  it('compiles again with the answers, and gives a token once no question is left', async () => {
    const fake = await claudeAnswers([weekendsAnsweredReply]);

    const { status, body } = await answer(
      await POST(await request({ text: WEEKENDS_TEXT, answers: { weekend_limit: 'Buy on any day' } })),
    );

    expect(status).toBe(200);
    expect(fake.requests[0].body).toMatchObject({
      messages: [{ content: expect.stringContaining('<answers>\nweekend_limit: Buy on any day\n</answers>') }],
    });
    expect(body.questions).toEqual([]);
    expect(isConfirmToken(body.confirmToken, WEEKENDS_TEXT, body.policy)).toBe(true);
  });

  it.each(["Don't set up this mandate", 'Don’t set up this mandate.'])(
    'refuses the decline answer %j with 400 and never compiles it',
    async (decline) => {
      const fake = await claudeAnswers([weekendsAnsweredReply]);

      const { status, body } = await answer(
        await POST(await request({ text: WEEKENDS_TEXT, answers: { weekend_limit: decline } })),
      );

      expect(status).toBe(400);
      expect(body).toEqual({ error: { message: 'You chose not to set up this mandate, so it was not compiled.' } });
      expect(fake.requests).toHaveLength(0);
    },
  );

  it.each([
    ['a body that is not JSON', '{', 'Send the mandate as JSON.'],
    ['no text', {}, 'Write your mandate first.'],
    ['blank text', { text: ' \n ' }, 'Write your mandate first.'],
    ['text over 2,000 characters', { text: 'a'.repeat(2_001) }, 'Keep your mandate under 2,000 characters.'],
    ['an answer that is not text', { text: TEXT, answers: { weekend_limit: 3 } }, 'Each answer must be short text.'],
    ['an empty answer', { text: TEXT, answers: { weekend_limit: ' ' } }, 'Each answer must be short text.'],
    ['an answer over 500 characters', { text: TEXT, answers: { weekend_limit: 'a'.repeat(501) } }, 'Each answer must be short text.'],
    ['an answer to a question id with a line break', { text: TEXT, answers: { 'a\nb': 'yes' } }, 'Each answer must name a question Behest asked.'],
    [
      'more than 20 answers',
      { text: TEXT, answers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`question_${i}`, 'yes'])) },
      'Each answer must name a question Behest asked.',
    ],
  ])('refuses %s with 400', async (_, body, message) => {
    const fake = await claudeAnswers([demoReply]);

    expect(await answer(await POST(await request(body)))).toEqual({ status: 400, body: { error: { message } } });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    ['a refusal', [refusalReply], {}, 422, 'refusal', 'This mandate could not be compiled. Try rewording it.'],
    [
      'a policy Behest cannot enforce',
      [nonUsdReply],
      {},
      422,
      'invalid_policy',
      'Behest could not turn this into a mandate it can enforce. Amounts must be in US dollars. Try rewording it.',
    ],
    ['an API error', [{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'boom' } } }], {}, 502, 'api_error', 'Compiling the mandate failed. Try again.'],
    ['the daily spend cap', [], { LLM_DAILY_CAP_USD: '0' }, 503, 'spend_cap', "Behest has used today's budget for model calls. Try again tomorrow."],
  ])('answers %s with %i and a message for the buyer', async (_, replies, env, status, code, message) => {
    await claudeAnswers(replies, { NODE_ENV: 'test', ...env });

    expect(await answer(await POST(await request({ text: TEXT })))).toEqual({ status, body: { error: { code, message } } });
  });

  it('counts compiles per address and persona against the model route limit, and answers 429 past it', async () => {
    const fake = await claudeAnswers([demoReply]);
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    const { status, body } = await answer(await POST(await request({ text: TEXT })));

    expect(rateLimit).toHaveBeenCalledWith('mandate_compile:203.0.113.7:buyer', MODEL_ROUTE_LIMIT);
    expect(status).toBe(429);
    expect(body).toEqual({ error: { message: 'Too many requests at once. Try again in a minute.' } });
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    [undefined, 401],
    ['forged', 401],
    ['seller', 403],
    ['operator', 403],
  ] as const)('answers a request with persona %s with %i and never compiles', async (persona, status) => {
    const fake = await claudeAnswers([demoReply]);

    const response = await POST(await request({ text: TEXT }, { persona: persona ?? null }));

    expect(response.status).toBe(status);
    expect(fake.requests).toHaveLength(0);
    expect(rateLimit).not.toHaveBeenCalled();
  });
});
