import type { Middleware } from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import type { BetaMessage, BetaMessageParam, BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages';
import { dailyCapUsd, type LlmDeps, type LlmFailure, type LlmResult, recordCall, spendCapFailure } from './client';
import { type LlmRoute, ROUTE_HEADER, routeConfig } from './routes';
import { type BilledUsage, billedUsage, FALLBACK_BETA, isMessage, salvagedUsage, stopFailure } from './structured';

// A bounded agent loop: the model calls the given tools, the SDK's tool runner runs them and sends
// their results back, until the model stops calling tools or the turns run out. Each turn is one
// request, logged to llm_calls and held to the daily spend cap like any other model call.

/**
 * The stop reasons after which the tool runner neither runs tools nor sends another request. After
 * any other reply it runs the tools or resumes the turn, so the spend cap is checked first.
 */
const FINAL_STOP_REASONS: ReadonlySet<BetaStopReason | null> = new Set<BetaStopReason | null>([
  null,
  'end_turn',
  'stop_sequence',
  'max_tokens',
  'model_context_window_exceeded',
  'refusal',
]);

/**
 * Whether the reply holds a tool call from before a fallback block. Such a call was made by a model
 * that declined the request, and a declining model must never trigger an action. Calls after the
 * last fallback block are the serving model's.
 */
function hasDeclinedToolCall(message: BetaMessage): boolean {
  const lastFallback = message.content.findLastIndex((block) => block.type === 'fallback');
  if (lastFallback === -1) return false;
  return message.content.slice(0, lastFallback).some((block) => block.type === 'tool_use');
}

/**
 * `tool` with its input schema in the form strict mode accepts. The API refuses a strict schema
 * holding minimum, maximum, minLength, maxLength or an array limit other than minItems 0 or 1, and
 * `betaZodTool` sends the schema as Zod writes it, so each such limit moves into its field's
 * description, as the SDK does for structured outputs, and the `$schema` dialect keyword is dropped.
 * The tool's own `parse` still checks the input against its whole schema before the tool runs.
 */
function strictInputSchema(tool: BetaRunnableTool): BetaRunnableTool {
  if (!('input_schema' in tool)) return tool;
  const schema: Record<string, unknown> = { ...tool.input_schema };
  delete schema.$schema;
  return { ...tool, input_schema: { ...transformJSONSchema(schema), type: 'object' } };
}

export type ToolLoopRequest = {
  system: string;
  messages: BetaMessageParam[];
  /** Built with `betaZodTool` and `strict: true`. A tool that throws is reported to the model as an error result. */
  tools: BetaRunnableTool<any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- each tool has its own input type
  /** The most requests the loop makes. */
  maxTurns: number;
  /** Called with each reply as it arrives, after it is logged. What it throws propagates. */
  onMessage?: (message: BetaMessage) => void;
  /**
   * Once aborted, the loop stops at the next turn boundary: a reply on its way is logged and its
   * tools are not run, and tools already running finish before the loop stops instead of sending
   * another request. Neither a request in flight nor a running tool is interrupted.
   */
  signal?: AbortSignal;
};

/** Thrown before a turn's request goes out once the loop's signal has aborted, so it is never sent. */
class LoopStopped extends Error {
  override name = 'LoopStopped';
}

/**
 * Runs the route's model over `req.tools` for at most `req.maxTurns` turns, unless today's spend has
 * reached the cap, and returns the last reply. The cap is checked again after every reply whose tools
 * would run, the last permitted turn's included, so once it is reached no tool runs and the loop
 * returns spend_cap. A loop that runs out of turns returns its last reply as it is: if that reply
 * called tools, they have run, but the model has not seen their results.
 *
 * A loop stopped through `req.signal` returns its last reply as it is, its tools run or not as the
 * signal documents, or, when it stopped before its first request, an api_error with no call made.
 *
 * Every failure of a request comes back as an LlmResult failure, with the turns before it logged. A
 * refused or cut-off turn ends the loop without running its tool calls, and so does a reply holding
 * a tool call from a model that declined the request (api_error). Only misconfiguration (an
 * override, cap, turn limit or tool it cannot use), database errors and an error thrown by
 * `onMessage` throw; the last stops the loop after the reply is logged and before its tools run.
 */
export async function runToolLoop(
  deps: LlmDeps,
  route: LlmRoute,
  req: ToolLoopRequest,
): Promise<LlmResult<BetaMessage>> {
  const env = deps.env ?? process.env;
  const { model, effort, maxTokens } = routeConfig(route, env);
  const cap = dailyCapUsd(env);
  // The runner treats a max_iterations of 0 as no limit at all.
  if (!Number.isInteger(req.maxTurns) || req.maxTurns < 1) {
    throw new Error(`maxTurns must be a whole number of turns, 1 or more, got ${req.maxTurns}`);
  }
  const loose = req.tools.filter((tool) => !('strict' in tool && tool.strict === true)).map((tool) => tool.name);
  if (loose.length > 0) throw new Error(`Every tool must set strict: true; ${loose.join(', ')} does not`);

  const capped = await spendCapFailure(deps.db, deps.now(), cap);
  if (capped) return capped;

  // The request of the turn in flight: when its first attempt started, and the request id of its
  // latest response. Tools run between turns, so their time is not counted as the turn's.
  let turn: { startedAt: Date | null; requestId: string | null } = { startedAt: null, requestId: null };
  const observeTurn: Middleware = async (request, next) => {
    // Checked before a turn's first attempt only: a retry belongs to a request already in flight.
    if (turn.startedAt === null && req.signal?.aborted) throw new LoopStopped('The loop was stopped');
    turn.startedAt ??= deps.now();
    const response = await next(request);
    turn.requestId = response.headers.get('request-id');
    return response;
  };
  const claude = deps.claude.withOptions({ middleware: [...deps.claude.middleware, observeTurn] });

  const runner = claude.beta.messages.toolRunner(
    {
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages: req.messages,
      tools: req.tools.map(strictInputSchema),
      output_config: { effort },
      // Automatic prompt caching: the marker moves to the end of the conversation each turn, so the
      // next turn reads everything before its new tool results from the cache.
      cache_control: { type: 'ephemeral' },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      max_iterations: req.maxTurns,
      // Every turn sends the whole conversation rather than continuing a server-held message thread.
      thread: false,
    },
    { headers: { [ROUTE_HEADER]: route } },
  );

  const logged = () => {
    const finishedAt = deps.now();
    return {
      route,
      model,
      effort,
      requestId: turn.requestId,
      latencyMs: finishedAt.getTime() - (turn.startedAt ?? finishedAt).getTime(),
      createdAt: finishedAt,
    };
  };

  const turns = runner[Symbol.asyncIterator]();
  let last: { message: BetaMessage; callId: string } | undefined;
  try {
    for (;;) {
      turn = { startedAt: null, requestId: null };
      let response: unknown;
      let message: BetaMessage;
      let billed: BilledUsage;
      try {
        // Runs the tools of the previous reply, if any, then sends this turn's request.
        const next = await turns.next();
        if (next.done) break;
        response = message = next.value;
        if (!isMessage(message)) throw new Error('The response was not a message');
        billed = billedUsage(message, model);
      } catch (error) {
        // No request went out for this turn, so there is no call to log.
        if (error instanceof LoopStopped) break;
        const detail = error instanceof Error ? error.message : String(error);
        const callId = await recordCall(deps.db, {
          ...logged(),
          ...salvagedUsage(response, model),
          ok: false,
          error: `api_error: ${detail}`,
        });
        return { ok: false, error: 'api_error', callId, detail };
      }

      // Checked before the runner gets control back, so a reply that fails never has its tools run.
      const failure: { error: LlmFailure; detail?: string } | null = hasDeclinedToolCall(message)
        ? { error: 'api_error', detail: 'A tool call came from a model that declined the request' }
        : stopFailure(message);
      const callId = await recordCall(deps.db, {
        ...logged(),
        ...billed,
        stopReason: message.stop_reason,
        ok: !failure,
        error: failure ? [failure.error, failure.detail].filter(Boolean).join(': ') : null,
      });
      req.onMessage?.(message);
      if (failure) return { ok: false, ...failure, callId };
      last = { message, callId };
      if (req.signal?.aborted) break;

      // Also on the last permitted turn, whose tools the runner still runs.
      if (!FINAL_STOP_REASONS.has(message.stop_reason)) {
        const cappedNow = await spendCapFailure(deps.db, deps.now(), cap);
        if (cappedNow) return cappedNow;
      }
    }
  } finally {
    // Closes the runner when the loop returns before the runner has finished.
    await turns.return?.();
  }

  if (!last && req.signal?.aborted) {
    return { ok: false, error: 'api_error', callId: null, detail: 'The loop was stopped before its first request' };
  }
  if (!last) throw new Error('The tool runner finished without a reply');
  return { ok: true, value: last.message, callId: last.callId };
}
