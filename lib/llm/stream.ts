import type { Middleware } from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { type LlmCallRow, type LlmDeps, type LlmFailure, recordCall, spendCapFailure, spendCaps } from './client';
import { type LlmRoute, ROUTE_HEADER, routeConfig } from './routes';
import { billedUsage, FALLBACK_BETA, isMessage, salvagedUsage, stopFailure } from './structured';

// One model call whose reply is passed on event by event as it arrives, for a reader that shows it
// live (the dashboard analyst). Like every model call it is held to the daily spend cap and logged
// to llm_calls, once, when the reply has ended.

/** Sent in place of the rest of the reply when the call cannot start or fails part way. */
export type LlmStreamError = {
  type: 'error';
  error: { type: Extract<LlmFailure, 'spend_cap' | 'api_error'>; message: string };
};

/** The Messages API stream events of the reply, then an error event if it failed. */
export type LlmStreamEvent = BetaRawMessageStreamEvent | LlmStreamError;

export type StreamRequest = { system: string; messages: BetaMessageParam[]; tools: BetaTool[] };

const streamError = (type: LlmStreamError['error']['type'], message: string): LlmStreamError => ({
  type: 'error',
  error: { type, message },
});

/** The fields of the llm_calls row that say how the call went and what it cost. */
type CallOutcome = Omit<LlmCallRow, 'route' | 'effort' | 'requestId' | 'latencyMs' | 'createdAt'>;

/**
 * Streams the route's reply to `req`, unless today's spend has reached the cap, and logs the call
 * once the reply has ended. A call that cannot start or fails part way ends with an error event
 * instead of throwing; a reader that stops early cancels the request, and the call is logged with
 * what it spent so far. Only misconfiguration (an override or cap it cannot use) and database
 * errors throw.
 *
 * The reply's thinking is summarized rather than omitted, so the reader can show it as it happens.
 */
export async function* streamReply(
  deps: LlmDeps,
  route: LlmRoute,
  req: StreamRequest,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<LlmStreamEvent, void, undefined> {
  const env = deps.env ?? process.env;
  const { model, effort, maxTokens } = routeConfig(route, env);
  const cap = spendCaps(route, env);
  const capped = await spendCapFailure(deps.db, deps.now(), cap);
  if (capped) {
    yield streamError('spend_cap', capped.detail ?? 'The daily model budget is spent');
    return;
  }

  let requestId: string | null = null;
  const captureRequestId: Middleware = async (request, next) => {
    const response = await next(request);
    requestId = response.headers.get('request-id');
    return response;
  };

  const startedAt = deps.now();
  const stream = deps.claude.beta.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      // Each turn of a conversation resends the turns before it, which are then read from the cache.
      cache_control: { type: 'ephemeral' },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    },
    { headers: { [ROUTE_HEADER]: route }, middleware: [captureRequestId], signal: opts.signal },
  );

  // The message in message_start is the object the stream then fills in with the rest of the reply,
  // so a reader that falls behind would see it changed. It is copied the moment it arrives.
  const started = new WeakMap<BetaRawMessageStreamEvent, BetaMessage>();
  stream.on('streamEvent', (event) => {
    if (event.type === 'message_start') started.set(event, structuredClone(event.message));
  });

  let outcome: CallOutcome | undefined;
  let failure: LlmStreamError | undefined;
  try {
    let reply: unknown;
    try {
      for await (const event of stream) {
        yield event.type === 'message_start' ? { ...event, message: started.get(event) ?? event.message } : event;
      }
      reply = await stream.finalMessage();
      if (!isMessage(reply as BetaMessage)) throw new Error('The response was not a message');
      const message = reply as BetaMessage;
      const billed = billedUsage(message, model);
      const stopped = stopFailure(message);
      outcome = {
        ...billed,
        stopReason: message.stop_reason,
        ok: !stopped,
        error: stopped ? [stopped.error, stopped.detail].filter(Boolean).join(': ') : null,
      };
    } catch (error) {
      // The SDK's errors, an error event in the stream, and anything a malformed reply breaks.
      const detail = error instanceof Error ? error.message : String(error);
      outcome = { model, ...salvagedUsage(reply ?? stream.currentMessage, model), ok: false, error: `api_error: ${detail}` };
      failure = streamError('api_error', detail);
    }
  } finally {
    // Reached without an outcome only when the reader stopped at one of the events above.
    if (!outcome) {
      stream.abort();
      outcome = {
        model,
        ...salvagedUsage(stream.currentMessage, model),
        ok: false,
        error: 'api_error: The reader stopped before the reply ended',
      };
    }
    const finishedAt = deps.now();
    await recordCall(deps.db, {
      route,
      effort,
      requestId,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
      createdAt: finishedAt,
      ...outcome,
    });
  }
  if (failure) yield failure;
}
