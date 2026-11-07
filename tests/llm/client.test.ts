import { describe, expect, it } from 'vitest';
import { llmCalls } from '@/lib/db/schema';
import { dailyCapUsd, recordCall, spendCapFailure, spendCaps, spentTodayUsd } from '@/lib/llm/client';
import { createTestDb } from '@/tests/helpers/test-db';

const NOW = new Date('2026-11-06T12:00:00Z');
const call = { route: 'intent_check', model: 'claude-opus-5-5', effort: 'low', ok: true };
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });

describe('recordCall', () => {
  it('stores one row and returns its id', async () => {
    const db = await createTestDb();
    const id = await recordCall(db, {
      ...call,
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: 0.014,
      stopReason: 'end_turn',
      requestId: 'req_1',
      latencyMs: 120,
      createdAt: NOW,
    });
    expect(await db.select().from(llmCalls)).toEqual([
      {
        id,
        ...call,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.014,
        stopReason: 'end_turn',
        requestId: 'req_1',
        latencyMs: 120,
        error: null,
        createdAt: NOW,
      },
    ]);
  });
});

describe('spentTodayUsd', () => {
  it('sums the cost of calls made on the UTC day of now', async () => {
    const db = await createTestDb();
    const at = (iso: string, costUsd: number) => recordCall(db, { ...call, costUsd, createdAt: new Date(iso) });
    await at('2026-11-05T23:59:59.999Z', 1);
    await at('2026-11-06T00:00:00.000Z', 0.25);
    await at('2026-11-06T23:59:59.999Z', 0.125);
    await at('2026-11-07T00:00:00.000Z', 2);
    expect(await spentTodayUsd(db, NOW)).toBe(0.375);
  });

  it('adds the stored decimals exactly', async () => {
    const db = await createTestDb();
    await recordCall(db, { ...call, costUsd: 0.1, createdAt: NOW });
    await recordCall(db, { ...call, costUsd: 0.2, createdAt: NOW });
    expect(await spentTodayUsd(db, NOW)).toBe(0.3);
  });

  it('is zero on a day without calls', async () => {
    const db = await createTestDb();
    expect(await spentTodayUsd(db, NOW)).toBe(0);
  });

  it("sums one route's calls when given the route", async () => {
    const db = await createTestDb();
    await recordCall(db, { ...call, route: 'studio_analyst', costUsd: 0.25, createdAt: NOW });
    await recordCall(db, { ...call, route: 'studio_analyst', costUsd: 0.5, createdAt: NOW });
    await recordCall(db, { ...call, route: 'mandate_compile', costUsd: 2, createdAt: NOW });
    expect(await spentTodayUsd(db, NOW, 'studio_analyst')).toBe(0.75);
    expect(await spentTodayUsd(db, NOW)).toBe(2.75);
  });
});

describe('spendCaps', () => {
  it('gives the analyst and the catalog builder a cap of their own, 1 dollar each by default', () => {
    expect(spendCaps('studio_analyst', env())).toEqual({ route: 'studio_analyst', dailyUsd: 5, routeDailyUsd: 1 });
    expect(spendCaps('catalog_build', env())).toEqual({ route: 'catalog_build', dailyUsd: 5, routeDailyUsd: 1 });
  });

  it('reads LLM_ANALYST_DAILY_CAP_USD and LLM_CATALOG_DAILY_CAP_USD', () => {
    const vars = env({ LLM_ANALYST_DAILY_CAP_USD: '0.5', LLM_CATALOG_DAILY_CAP_USD: '2' });
    expect(spendCaps('studio_analyst', vars).routeDailyUsd).toBe(0.5);
    expect(spendCaps('catalog_build', vars).routeDailyUsd).toBe(2);
  });

  it.each(['mandate_compile', 'intent_check', 'shopping_agent', 'dispute_evidence'] as const)(
    'leaves %s under the overall cap alone',
    (route) => {
      expect(spendCaps(route, env({ LLM_DAILY_CAP_USD: '3' }))).toEqual({ route, dailyUsd: 3, routeDailyUsd: null });
    },
  );

  it('rejects a route cap that is not a non-negative amount', () => {
    expect(() => spendCaps('studio_analyst', env({ LLM_ANALYST_DAILY_CAP_USD: '-1' }))).toThrow(
      'LLM_ANALYST_DAILY_CAP_USD must be a non-negative amount in dollars, got "-1"',
    );
    expect(() => spendCaps('catalog_build', env({ LLM_CATALOG_DAILY_CAP_USD: 'one' }))).toThrow(
      'LLM_CATALOG_DAILY_CAP_USD must be a non-negative amount in dollars, got "one"',
    );
  });
});

describe('spendCapFailure', () => {
  it("stops the analyst once its own day's cap is spent, but not the mandate compiler", async () => {
    const db = await createTestDb();
    await recordCall(db, { ...call, route: 'studio_analyst', costUsd: 1, createdAt: NOW });

    expect(await spendCapFailure(db, NOW, spendCaps('studio_analyst', env()))).toEqual({
      ok: false,
      error: 'spend_cap',
      callId: null,
      detail: 'Spent $1 of the $1 daily model budget for studio_analyst',
    });
    expect(await spendCapFailure(db, NOW, spendCaps('mandate_compile', env()))).toBeNull();
    expect(await spendCapFailure(db, NOW, spendCaps('catalog_build', env()))).toBeNull();
  });

  it('counts what the analyst and the catalog builder spend against the overall cap too', async () => {
    const db = await createTestDb();
    await recordCall(db, { ...call, route: 'studio_analyst', costUsd: 0.75, createdAt: NOW });
    await recordCall(db, { ...call, route: 'catalog_build', costUsd: 0.25, createdAt: NOW });

    expect(await spendCapFailure(db, NOW, spendCaps('mandate_compile', env({ LLM_DAILY_CAP_USD: '1' })))).toEqual({
      ok: false,
      error: 'spend_cap',
      callId: null,
      detail: 'Spent $1 of the $1 daily model budget',
    });
  });
});

describe('dailyCapUsd', () => {
  it('defaults to 5 dollars', () => {
    expect(dailyCapUsd(env())).toBe(5);
    expect(dailyCapUsd(env({ LLM_DAILY_CAP_USD: ' ' }))).toBe(5);
  });

  it('reads LLM_DAILY_CAP_USD', () => {
    expect(dailyCapUsd(env({ LLM_DAILY_CAP_USD: '0.5' }))).toBe(0.5);
    expect(dailyCapUsd(env({ LLM_DAILY_CAP_USD: '0' }))).toBe(0);
  });

  it('rejects a cap that is not a non-negative amount', () => {
    for (const value of ['five', '-1', 'Infinity']) {
      expect(() => dailyCapUsd(env({ LLM_DAILY_CAP_USD: value }))).toThrow(
        `LLM_DAILY_CAP_USD must be a non-negative amount in dollars, got "${value}"`,
      );
    }
  });
});
