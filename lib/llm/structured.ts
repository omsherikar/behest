import type { Middleware } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRefusalStopDetails,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { dailyCapUsd, type LlmDeps, type LlmFailure, type LlmResult, recordCall, spentTodayUsd } from './client';
import { estimateCostUsd, type TokenUsage } from './prices';
import { type LlmRoute, ROUTE_HEADER, routeConfig } from './routes';

// One model call whose reply must match a zod schema. Every way it can go wrong comes back as an
// LlmResult failure rather than a value, so callers that decide money can treat any failure as "no".

/** Server-side fallback: a declined request is retried on the model Anthropic picks for the refusal. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/** Reply text checked against the schema. */
function checkText<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, detail: 'The reply was not JSON' };
  }
  const parsed = schema.safeParse(data);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, detail: z.prettifyError(parsed.error) };
}

/**
 * The structured output format for `schema`. The SDK's own parser throws on a reply that does not
 * match, which would lose the stop reason and token usage the call log needs, so this one reports
 * the mismatch as a value instead.
 */
function outputFormat<T>(schema: z.ZodType<T>) {
  return { ...betaZodOutputFormat(schema), parse: (text: string) => checkText(schema, text) };
}

function textOf(blocks: readonly BetaContentBlock[]): string {
  return blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

/**
 * The reply checked against the schema. The SDK parses only the first text block, which is enough
 * unless a server-side fallback happened. Then the content is the declining model's text, a
 * `fallback` block, and the fallback model's text, which either continues the declined text or
 * starts over. So the whole text is tried, then the text after the last fallback alone. Text from
 * before a fallback is never taken on its own: it came from a model that declined.
 */
function readReply<T>(
  schema: z.ZodType<T>,
  message: { content: readonly BetaContentBlock[]; parsed_output: Parsed<T> | null },
): Parsed<T> {
  const lastFallback = message.content.findLastIndex((block) => block.type === 'fallback');
  if (lastFallback === -1) return message.parsed_output ?? { ok: false, detail: 'The reply had no text' };
  const afterFallback = textOf(message.content.slice(lastFallback + 1));
  if (!afterFallback.trim()) return { ok: false, detail: 'The reply had no text after the fallback' };
  const whole = checkText(schema, textOf(message.content));
  return whole.ok ? whole : checkText(schema, afterFallback);
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: LlmFailure; detail?: string };

/** Whether a successful response has the fields of a message that the checks and the log read. */
function isMessage(message: Pick<BetaMessage, 'model' | 'usage'>): boolean {
  const usage: Partial<BetaUsage> | null | undefined = message.usage;
  return (
    typeof message.model === 'string' &&
    typeof usage?.input_tokens === 'number' &&
    typeof usage.output_tokens === 'number'
  );
}

/** What a reply cost, as logged in its llm_calls row. */
export type BilledUsage = {
  /** The model that served the reply. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/** Whether `count` is a token count: a whole number, zero or more. */
function isCount(count: unknown): boolean {
  return Number.isInteger(count) && (count as number) >= 0;
}

/** Whether a usage object's token counts are all counts. The API reports absent cache counts as null. */
function hasCounts(usage: TokenUsage): boolean {
  return (
    isCount(usage.input_tokens) &&
    isCount(usage.output_tokens) &&
    (usage.cache_read_input_tokens == null || isCount(usage.cache_read_input_tokens)) &&
    (usage.cache_creation_input_tokens == null || isCount(usage.cache_creation_input_tokens))
  );
}

/**
 * The tokens and estimated cost of a reply. After a server-side fallback the top-level usage covers
 * only the model that served the reply, and `usage.iterations` lists every model's attempt, so each
 * attempt is priced at its own model's rates and the counts are summed. An attempt that names no
 * model is the requested model's, unless the reply fell back: then it could be any model in the
 * chain, so it is charged the highest rates. Throws on usage that is not made of token counts.
 */
export function billedUsage(message: Pick<BetaMessage, 'model' | 'usage'>, requestedModel: string): BilledUsage {
  const iterations = message.usage.iterations ?? [];
  const fellBack = iterations.some((usage) => usage.type === 'fallback_message');
  const unnamedModel = fellBack ? null : requestedModel;
  const attempts: { model: string | null; usage: TokenUsage }[] =
    iterations.length > 0
      ? iterations.map((usage) => ({ model: ('model' in usage && usage.model) || unnamedModel, usage }))
      : [{ model: message.model, usage: message.usage }];
  if (!attempts.every((attempt) => hasCounts(attempt.usage))) {
    throw new Error('The reply reported token usage that is not a count');
  }
  const total = (count: (usage: TokenUsage) => number) =>
    attempts.reduce((sum, attempt) => sum + count(attempt.usage), 0);
  const costUsd = attempts.reduce((sum, attempt) => sum + estimateCostUsd(attempt.model, attempt.usage), 0);
  return {
    model: message.model,
    inputTokens: total((usage) => usage.input_tokens),
    outputTokens: total((usage) => usage.output_tokens),
    cacheReadTokens: total((usage) => usage.cache_read_input_tokens ?? 0),
    cacheWriteTokens: total((usage) => usage.cache_creation_input_tokens ?? 0),
    // Each attempt's cost is already whole micro-dollars; rounding drops the float error of the sum.
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}

function refusalDetail(details: BetaRefusalStopDetails | null): string | undefined {
  return details?.explanation ?? details?.category ?? undefined;
}

/**
 * Asks the route's model for a reply matching `req.schema`, unless today's spend has reached the
 * cap, and logs the call. Every failure of the call itself is returned; only misconfiguration
 * (an override, cap or schema it cannot use) and database errors throw.
 */
export async function callStructured<T>(
  deps: LlmDeps,
  route: LlmRoute,
  req: { system: string; messages: BetaMessageParam[]; schema: z.ZodType<T> },
): Promise<LlmResult<T>> {
  const env = deps.env ?? process.env;
  const { model, effort, maxTokens } = routeConfig(route, env);
  const cap = dailyCapUsd(env);
  // Built before the request, so a schema that cannot become a JSON schema throws as the bug it is.
  const format = outputFormat(req.schema);
  const spent = await spentTodayUsd(deps.db, deps.now());
  if (spent >= cap) {
    return { ok: false, error: 'spend_cap', callId: null, detail: `Spent $${spent} of the $${cap} daily model budget` };
  }

  let requestId: string | null = null;
  const captureRequestId: Middleware = async (request, next) => {
    const response = await next(request);
    requestId = response.headers.get('request-id');
    return response;
  };

  const startedAt = deps.now();
  const logged = (finishedAt: Date) => ({
    route,
    model,
    effort,
    requestId,
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    createdAt: finishedAt,
  });

  let message;
  try {
    message = await deps.claude.beta.messages.parse(
      {
        model,
        max_tokens: maxTokens,
        system: req.system,
        messages: req.messages,
        output_config: { effort, format },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      },
      { headers: { [ROUTE_HEADER]: route }, middleware: [captureRequestId] },
    );
    if (!isMessage(message)) throw new Error('The response was not a message');
  } catch (error) {
    // The SDK's errors, and anything a malformed response breaks while it is read, such as a 200
    // carrying an HTML page.
    const detail = error instanceof Error ? error.message : String(error);
    const callId = await recordCall(deps.db, { ...logged(deps.now()), ok: false, error: `api_error: ${detail}` });
    return { ok: false, error: 'api_error', callId, detail };
  }

  const outcome = ((): Outcome<T> => {
    if (message.stop_reason === 'refusal') {
      return { ok: false, error: 'refusal', detail: refusalDetail(message.stop_details) };
    }
    if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
      return { ok: false, error: 'max_tokens', detail: `The reply stopped with ${message.stop_reason}` };
    }
    if (message.stop_reason !== 'end_turn') {
      return { ok: false, error: 'invalid_output', detail: `The reply stopped with ${message.stop_reason}` };
    }
    const reply = readReply(req.schema, message);
    return reply.ok ? reply : { ok: false, error: 'invalid_output', detail: reply.detail };
  })();

  const callId = await recordCall(deps.db, {
    ...logged(deps.now()),
    ...billedUsage(message, model),
    stopReason: message.stop_reason,
    ok: outcome.ok,
    error: outcome.ok ? null : [outcome.error, outcome.detail].filter(Boolean).join(': '),
  });
  return outcome.ok ? { ok: true, value: outcome.value, callId } : { ...outcome, callId };
}
