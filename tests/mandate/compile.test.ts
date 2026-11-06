import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaude } from '@/lib/llm/client';
import { compileMandate } from '@/lib/mandate/compile';
import { MANDATE_SYSTEM_PROMPT } from '@/lib/mandate/prompts';
import demoReply from '@/tests/fixtures/llm/mandate_compile/demo.json';
import noAmountReply from '@/tests/fixtures/llm/mandate_compile/no-amount.json';
import nonUsdReply from '@/tests/fixtures/llm/mandate_compile/non-usd.json';
import onlyCoffeeReply from '@/tests/fixtures/llm/mandate_compile/only-coffee.json';
import refusalReply from '@/tests/fixtures/llm/mandate_compile/refusal.json';
import unknownSellerReply from '@/tests/fixtures/llm/mandate_compile/unknown-seller.json';
import weekendsAnsweredReply from '@/tests/fixtures/llm/mandate_compile/weekends-answered.json';
import weekendsReply from '@/tests/fixtures/llm/mandate_compile/weekends-question.json';
import { fakeClaude, messageJson } from '@/tests/helpers/fake-claude';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { createTestDb } from '@/tests/helpers/test-db';

const NOW = new Date('2026-11-06T12:00:00Z');
const DEMO_TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';

const demoReadback = [
  'Your agent can spend up to $60.00 per calendar month (UTC).',
  'Any single purchase over $60.00 is blocked.',
  'Purchases over $25.00 need your approval.',
  'Allowed categories: groceries, spices.',
  'Never: electronics.',
  'Any seller.',
  'No limit on how often it buys.',
  'No end date.',
];

const PER_PURCHASE_ASSUMPTION =
  'No limit was given for a single purchase, so one purchase can use the whole $60 monthly budget.';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function depsFor(claude: Anthropic) {
  return { db: await createTestDb(), claude, now: () => NOW, env: { NODE_ENV: 'test' as const } };
}

/** Compiles `text` with a fake Claude that sends `reply`, and returns the result and the request body. */
async function compileWith(reply: object, text = DEMO_TEXT, answers?: Record<string, string>) {
  const fake = fakeClaude([reply]);
  const deps = await depsFor(new Anthropic({ apiKey: 'test', fetch: fake.fetch, maxRetries: 0 }));
  const result = await compileMandate(deps, text, answers);
  return { result, sent: fake.requests[0]?.body };
}

/** A reply whose policy is the demo policy with some fields changed, with no assumptions or questions. */
const replyWithPolicy = (changes: Record<string, unknown>) =>
  messageJson({ json: { policy: { ...demoPolicy, ...changes }, assumptions: [], questions: [] } });

it('compiles the demo mandate into the demo policy and its readback', async () => {
  const { result } = await compileWith(demoReply);

  expect(result).toEqual({
    ok: true,
    policy: demoPolicy,
    readback: demoReadback,
    assumptions: [PER_PURCHASE_ASSUMPTION],
    questions: [],
  });
});

describe('the request', () => {
  it('sends the system prompt, then the date and the mandate verbatim', async () => {
    const { sent } = await compileWith(demoReply);

    expect(sent).toMatchObject({
      system: [{ type: 'text', text: MANDATE_SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: `Today is Friday, 2026-11-06 (UTC).\n\n<mandate>\n${DEMO_TEXT}\n</mandate>` }],
    });
  });

  it('adds the answers one per line after the mandate', async () => {
    const answers = { weekend_days: 'Saturday and Sunday', ravi_seller: 'ravi-spices' };

    const { sent } = await compileWith(demoReply, DEMO_TEXT, answers);

    expect(sent?.messages).toEqual([
      {
        role: 'user',
        content:
          `Today is Friday, 2026-11-06 (UTC).\n\n<mandate>\n${DEMO_TEXT}\n</mandate>\n\n` +
          '<answers>\nweekend_days: Saturday and Sunday\nravi_seller: ravi-spices\n</answers>',
      },
    ]);
  });

  it('sends no answers block when there are no answers', async () => {
    const { sent } = await compileWith(demoReply, DEMO_TEXT, {});

    expect(JSON.stringify(sent?.messages)).not.toContain('<answers>');
  });
});

describe('a mandate Behest cannot honour is never compiled silently', () => {
  it('rejects amounts in rupees', async () => {
    const { result } = await compileWith(
      nonUsdReply,
      '₹5000 a month on groceries and spices, ask me above ₹2000, never electronics',
    );

    expect(result).toEqual({ ok: false, error: 'invalid_policy', issues: ['currency: Invalid input: expected "USD"'] });
  });

  it('keeps a weekends limit out of the policy and lists it as not enforced, even after the buyer answers', async () => {
    const text = '$60 a month on groceries and spices, only on weekends, ask me above $25, never electronics';
    const notEnforced = [PER_PURCHASE_ASSUMPTION, 'not enforced: only on weekends'];

    const first = await compileWith(weekendsReply, text);

    expect(first.result).toEqual({
      ok: true,
      policy: demoPolicy,
      readback: demoReadback,
      assumptions: notEnforced,
      questions: [
        {
          id: 'weekend_limit',
          question: "Behest can't limit purchases to weekends, so your agent could buy on any day. Do you want to go ahead?",
          options: ['Buy on any day', "Don't set up this mandate"],
        },
      ],
    });
    if (!first.result.ok) throw new Error('The first round should compile');

    const [question] = first.result.questions;
    const second = await compileWith(weekendsAnsweredReply, text, { [question.id]: question.options[0] });

    expect(second.sent).toMatchObject({
      messages: [{ role: 'user', content: expect.stringContaining('<answers>\nweekend_limit: Buy on any day\n</answers>') }],
    });
    expect(second.result).toEqual({
      ok: true,
      policy: demoPolicy,
      readback: demoReadback,
      assumptions: notEnforced,
      questions: [],
    });
  });

  it('asks which seller Ravi is and allows no seller until the buyer says', async () => {
    const { result } = await compileWith(
      unknownSellerReply,
      '$60 a month on groceries and spices from Ravi, ask me above $25, never electronics',
    );

    expect(result).toMatchObject({
      ok: true,
      policy: { ...demoPolicy, merchants: { allow: [], deny: [] } },
      readback: expect.arrayContaining(['No seller is allowed.']),
      questions: [{ id: 'ravi_seller', question: expect.stringContaining('"Ravi"'), options: [] }],
    });
  });

  it('asks before widening only coffee to every beverage, and allows no category meanwhile', async () => {
    const { result } = await compileWith(onlyCoffeeReply, '$30 a month, only coffee');

    expect(result).toMatchObject({
      ok: true,
      policy: { categories: { allow: [], deny: [] } },
      readback: expect.arrayContaining(['No category is allowed.']),
      assumptions: expect.arrayContaining(['not enforced: only coffee; allowing it means allowing all beverages']),
      questions: [
        {
          id: 'allow_all_beverages',
          question: expect.stringContaining('all beverages'),
          options: ['Allow all beverages', "Don't set up this mandate"],
        },
      ],
    });
  });

  it('asks for an amount the mandate leaves out, and lets nothing be bought without the buyer meanwhile', async () => {
    const { result } = await compileWith(noAmountReply, 'Buy my groceries, never electronics');

    expect(result).toMatchObject({
      ok: true,
      policy: { budget: { amountCents: 1, period: 'once' }, perPurchaseMaxCents: 1, askAboveCents: 0 },
      readback: expect.arrayContaining([
        'Your agent can spend up to $0.01 in total.',
        'Purchases over $0.00 need your approval.',
      ]),
      questions: [{ id: 'budget_amount', question: expect.any(String), options: [] }],
    });
  });

  it('rejects a zero budget', async () => {
    const { result } = await compileWith(
      replyWithPolicy({ budget: { amountCents: 0, period: 'month' }, perPurchaseMaxCents: 0, askAboveCents: null }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'invalid_policy',
      issues: [
        'budget.amountCents: Too small: expected number to be >0',
        'perPurchaseMaxCents: Too small: expected number to be >0',
      ],
    });
  });

  it('rejects a seller written as a name instead of a slug', async () => {
    const { result } = await compileWith(replyWithPolicy({ merchants: { allow: ['Ravi'], deny: [] } }));

    expect(result).toEqual({
      ok: false,
      error: 'invalid_policy',
      issues: ['merchants.allow.0: Invalid string: must match pattern /^[a-z0-9][a-z0-9-]{0,62}$/'],
    });
  });

  it('treats a category outside the list as an invalid reply', async () => {
    const { result } = await compileWith(replyWithPolicy({ categories: { allow: ['fireworks'], deny: [] } }));

    expect(result).toEqual({ ok: false, error: 'invalid_output' });
  });
});

it('checks the rules that span policy fields', async () => {
  const { result } = await compileWith(replyWithPolicy({ perPurchaseMaxCents: 7000 }));

  expect(result).toEqual({
    ok: false,
    error: 'invalid_policy',
    issues: ['perPurchaseMaxCents: perPurchaseMaxCents cannot exceed the budget'],
  });
});

describe('expiry', () => {
  it.each<{ written: string; enforced: string; line: string }>([
    { written: '2026-12-31T23:59:59.999Z', enforced: '2026-12-31T23:59:59.999Z', line: 'Ends on 2026-12-31.' },
    { written: '2026-12-31T23:59:59Z', enforced: '2026-12-31T23:59:59.999Z', line: 'Ends on 2026-12-31.' },
    { written: '2026-12-31T23:59:00Z', enforced: '2026-12-31T23:59:59.999Z', line: 'Ends on 2026-12-31.' },
    { written: '2026-12-31T23:58:59.999Z', enforced: '2026-12-31T23:58:00.000Z', line: 'Ends on 2026-12-31 at 23:58 UTC.' },
    { written: '2026-12-31T18:30:45.5Z', enforced: '2026-12-31T18:30:00.000Z', line: 'Ends on 2026-12-31 at 18:30 UTC.' },
    { written: '2026-12-31T18:30:00Z', enforced: '2026-12-31T18:30:00.000Z', line: 'Ends on 2026-12-31 at 18:30 UTC.' },
    { written: '2027-01-01T05:29:30+05:30', enforced: '2026-12-31T23:59:59.999Z', line: 'Ends on 2026-12-31.' },
  ])('enforces $written as $enforced', async ({ written, enforced, line }) => {
    const { result } = await compileWith(replyWithPolicy({ expiresAt: written }));

    expect(result).toMatchObject({ ok: true, policy: { expiresAt: enforced } });
    expect((result as { readback: string[] }).readback.at(-1)).toBe(line);
  });
});

it('passes a refusal through', async () => {
  const { result } = await compileWith(refusalReply);

  expect(result).toEqual({ ok: false, error: 'refusal' });
});

it('replays the recorded demo compile when LLM_STUB=1', async () => {
  vi.stubEnv('LLM_STUB', '1');

  const result = await compileMandate(await depsFor(createClaude()), DEMO_TEXT);

  expect(result).toMatchObject({ ok: true, policy: demoPolicy, readback: demoReadback });
});
