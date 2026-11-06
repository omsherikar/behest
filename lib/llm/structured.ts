import Anthropic, { type Middleware } from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaMessageParam, BetaRefusalStopDetails } from '@anthropic-ai/sdk/resources/beta/messages';
import { z } from 'zod';
import { dailyCapUsd, type LlmDeps, type LlmFailure, type LlmResult, recordCall, spentTodayUsd } from './client';
import { estimateCostUsd } from './prices';
import { type LlmRoute, ROUTE_HEADER, routeConfig } from './routes';

// One model call whose reply must match a zod schema. Every way it can go wrong comes back as an
// LlmResult failure rather than a value, so callers that decide money can treat any failure as "no".

/** Server-side fallback: a declined request is retried on the model Anthropic picks for the refusal. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * The structured output format for `schema`. The SDK's own parser throws on a reply that does not
 * match, which would lose the stop reason and token usage the call log needs, so this one reports
 * the mismatch as a value instead.
 */
function outputFormat<T>(schema: z.ZodType<T>) {
  return {
    ...betaZodOutputFormat(schema),
    parse(content: string): Parsed<T> {
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        return { ok: false, detail: 'The reply was not JSON' };
      }
      const parsed = schema.safeParse(data);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, detail: z.prettifyError(parsed.error) };
    },
  };
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: LlmFailure; detail?: string };

function refusalDetail(details: BetaRefusalStopDetails | null): string | undefined {
  return details?.explanation ?? details?.category ?? undefined;
}

/**
 * Asks the route's model for a reply matching `req.schema`, unless today's spend has reached the
 * cap, and logs the call. Every failure of the call itself is returned; only misconfiguration
 * (an override or cap it cannot honour) and database errors throw.
 */
export async function callStructured<T>(
  deps: LlmDeps,
  route: LlmRoute,
  req: { system: string; messages: BetaMessageParam[]; schema: z.ZodType<T> },
): Promise<LlmResult<T>> {
  const env = deps.env ?? process.env;
  const { model, effort, maxTokens } = routeConfig(route, env);
  const cap = dailyCapUsd(env);
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
        output_config: { effort, format: outputFormat(req.schema) },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      },
      { headers: { [ROUTE_HEADER]: route }, middleware: [captureRequestId] },
    );
  } catch (error) {
    if (!(error instanceof Anthropic.AnthropicError)) throw error;
    const detail = error.message;
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
    const parsed = message.parsed_output;
    if (!parsed) return { ok: false, error: 'invalid_output', detail: 'The reply had no text' };
    if (!parsed.ok) return { ok: false, error: 'invalid_output', detail: parsed.detail };
    return { ok: true, value: parsed.value };
  })();

  const { usage } = message;
  const callId = await recordCall(deps.db, {
    ...logged(deps.now()),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: estimateCostUsd(model, usage),
    stopReason: message.stop_reason,
    ok: outcome.ok,
    error: outcome.ok ? null : [outcome.error, outcome.detail].filter(Boolean).join(': '),
  });
  return outcome.ok ? { ok: true, value: outcome.value, callId } : { ...outcome, callId };
}
