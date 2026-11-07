import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, gte, lt, sum } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { llmCalls } from '@/lib/db/schema';
import { LLM_ROUTES, type LlmRoute, ROUTE_HEADER } from './routes';

// Every model call goes through lib/llm. Each one is logged to llm_calls with its estimated cost, and
// no call starts once the day's logged cost reaches LLM_DAILY_CAP_USD. The dashboard analyst and the
// catalog builder, which any visitor can set off, also stop at a smaller daily cap of their own, so
// they cannot spend the budget that mandates, purchases and disputes need.

/**
 * Where LLM_STUB finds the reply recorded for each route: `<route>/stub.json`, or for a streamed
 * request the server-sent events of `<route>/stub.sse`. A `stub.json` holding an array scripts a
 * conversation, such as a tool loop's turns: see scriptedReply.
 */
const STUB_DIR = path.join('tests', 'fixtures', 'llm');

function apiErrorResponse(status: number, type: string, message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

/**
 * The reply to send from a recorded `stub.json`. An array scripts a conversation: a request is
 * answered with the entry at the index of its count of assistant turns, so the first turn gets the
 * first entry, and with the last entry once the script runs out. Anything else is sent as it is.
 */
function scriptedReply(recorded: string, sent: unknown): string {
  let script: unknown;
  try {
    script = JSON.parse(recorded);
  } catch {
    return recorded;
  }
  if (!Array.isArray(script) || script.length === 0) return recorded;
  const messages = (sent as { messages?: unknown } | null)?.messages;
  const turn = Array.isArray(messages) ? messages.filter((message) => message?.role === 'assistant').length : 0;
  return JSON.stringify(script[Math.min(turn, script.length - 1)]);
}

/** A `fetch` that answers each request with the reply recorded for the route its header names. */
const replayRecordedReply: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const route = request.headers.get(ROUTE_HEADER);
  if (!route || !(LLM_ROUTES as string[]).includes(route)) {
    return apiErrorResponse(400, 'invalid_request_error', `The ${ROUTE_HEADER} header names no known route`);
  }
  const sent: unknown = await request.json().catch(() => null);
  const streamed = typeof sent === 'object' && sent !== null && 'stream' in sent && sent.stream === true;
  const file = path.join(STUB_DIR, route, streamed ? 'stub.sse' : 'stub.json');
  let body: string;
  try {
    body = await readFile(path.join(process.cwd(), file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return apiErrorResponse(404, 'not_found_error', `No recorded reply at ${file}`);
  }
  const contentType = streamed ? 'text/event-stream' : 'application/json';
  const reply = streamed ? body : scriptedReply(body, sent);
  return new Response(reply, { headers: { 'content-type': contentType, 'request-id': 'stub' } });
};

/**
 * The Claude client. It reads ANTHROPIC_API_KEY from the environment. With LLM_STUB=1 it sends
 * nothing and replays recorded replies instead, so the app can be exercised without spending; that
 * is refused in production.
 */
export function createClaude(opts: { fetch?: typeof fetch } = {}): Anthropic {
  if (process.env.LLM_STUB === '1') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('LLM_STUB replays recorded replies and must not be set in production');
    }
    return new Anthropic({ apiKey: 'stub', fetch: replayRecordedReply });
  }
  return new Anthropic({ fetch: opts.fetch });
}

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

/**
 * The logged cost in US dollars of the calls made on the UTC calendar day that contains `now`, on
 * every route, or on `route` alone when one is given.
 */
export async function spentTodayUsd(db: Db, now: Date, route?: LlmRoute): Promise<number> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);
  const onRoute = route === undefined ? undefined : eq(llmCalls.route, route);
  const [row] = await db
    .select({ total: sum(llmCalls.costUsd) })
    .from(llmCalls)
    .where(and(gte(llmCalls.createdAt, dayStart), lt(llmCalls.createdAt, dayEnd), onRoute));
  // Postgres adds the numeric column exactly and the driver returns the total as a decimal string.
  return Number(row?.total ?? 0);
}

/**
 * The daily caps a route's calls stop at, in US dollars: the overall one, which every route's spend
 * counts against, and the route's own, or null for a route without one.
 */
export type SpendCaps = { route: LlmRoute; dailyUsd: number; routeDailyUsd: number | null };

/**
 * The spend_cap failure to return instead of calling the model once the logged spend of the UTC day
 * that contains `now` has reached the overall cap, or the route's own spend that day has reached the
 * route's own cap; null while both are under.
 */
export async function spendCapFailure(
  db: Db,
  now: Date,
  { route, dailyUsd, routeDailyUsd }: SpendCaps,
): Promise<Extract<LlmResult<never>, { ok: false }> | null> {
  const spent = await spentTodayUsd(db, now);
  if (spent >= dailyUsd) {
    return { ok: false, error: 'spend_cap', callId: null, detail: `Spent $${spent} of the $${dailyUsd} daily model budget` };
  }
  if (routeDailyUsd === null) return null;
  const routeSpent = await spentTodayUsd(db, now, route);
  if (routeSpent < routeDailyUsd) return null;
  return {
    ok: false,
    error: 'spend_cap',
    callId: null,
    detail: `Spent $${routeSpent} of the $${routeDailyUsd} daily model budget for ${route}`,
  };
}

export const DEFAULT_DAILY_CAP_USD = 5;

/** The default of a route's own daily cap, in US dollars. */
export const DEFAULT_ROUTE_DAILY_CAP_USD = 1;

/**
 * The routes with a daily cap of their own, and the setting that holds each: the ones any visitor can
 * set off with a large request. Every other route stops only at the overall cap.
 */
const ROUTE_CAP_SETTINGS: Partial<Record<LlmRoute, string>> = {
  studio_analyst: 'LLM_ANALYST_DAILY_CAP_USD',
  catalog_build: 'LLM_CATALOG_DAILY_CAP_USD',
};

/** The cap in US dollars the setting `name` holds, or `fallback` when it is unset. Throws unless it is a non-negative amount. */
function capFrom(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const cap = Number(raw);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error(`${name} must be a non-negative amount in dollars, got "${raw}"`);
  }
  return cap;
}

/** The most the app may spend on model calls per UTC day, from LLM_DAILY_CAP_USD. */
export function dailyCapUsd(env: NodeJS.ProcessEnv = process.env): number {
  return capFrom(env, 'LLM_DAILY_CAP_USD', DEFAULT_DAILY_CAP_USD);
}

/** The daily caps a call on `route` must stay under. Throws on a cap setting it cannot use. */
export function spendCaps(route: LlmRoute, env: NodeJS.ProcessEnv = process.env): SpendCaps {
  const setting = ROUTE_CAP_SETTINGS[route];
  return {
    route,
    dailyUsd: dailyCapUsd(env),
    routeDailyUsd: setting === undefined ? null : capFrom(env, setting, DEFAULT_ROUTE_DAILY_CAP_USD),
  };
}
