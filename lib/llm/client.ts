import type Anthropic from '@anthropic-ai/sdk';
import { and, gte, lt, sum } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { llmCalls } from '@/lib/db/schema';

// Every model call goes through lib/llm. Each one is logged to llm_calls with its estimated cost, and
// no call starts once the day's logged cost reaches LLM_DAILY_CAP_USD.

export interface LlmDeps {
  db: Db;
  claude: Anthropic;
  now: () => Date;
  /** Read for route overrides and the daily cap. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export type LlmFailure = 'refusal' | 'max_tokens' | 'invalid_output' | 'api_error' | 'spend_cap';

/** `callId` is the llm_calls row for the call, or null when no call was made. */
export type LlmResult<T> =
  | { ok: true; value: T; callId: string }
  | { ok: false; error: LlmFailure; callId: string | null; detail?: string };

export type LlmCallRow = Omit<typeof llmCalls.$inferInsert, 'id'>;

/** Logs one model call and returns its id. */
export async function recordCall(db: Db, row: LlmCallRow): Promise<string> {
  const [inserted] = await db.insert(llmCalls).values(row).returning({ id: llmCalls.id });
  return inserted.id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The logged cost in US dollars of the calls made on the UTC calendar day that contains `now`. */
export async function spentTodayUsd(db: Db, now: Date): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const [row] = await db
    .select({ total: sum(llmCalls.costUsd) })
    .from(llmCalls)
    .where(and(gte(llmCalls.createdAt, dayStart), lt(llmCalls.createdAt, dayEnd)));
  // Postgres adds the numeric column exactly and the driver returns the total as a decimal string.
  return Number(row?.total ?? 0);
}

export const DEFAULT_DAILY_CAP_USD = 5;

/** The most the app may spend on model calls per UTC day, from LLM_DAILY_CAP_USD. */
export function dailyCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLM_DAILY_CAP_USD?.trim();
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error(`LLM_DAILY_CAP_USD must be a non-negative amount in dollars, got "${raw}"`);
  }
  return cap;
}
