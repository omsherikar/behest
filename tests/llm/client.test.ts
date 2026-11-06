import { describe, expect, it } from 'vitest';
import { llmCalls } from '@/lib/db/schema';
import { dailyCapUsd, recordCall, spentTodayUsd } from '@/lib/llm/client';
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
