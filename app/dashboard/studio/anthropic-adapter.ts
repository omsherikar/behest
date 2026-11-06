// AG Studio's AI runs in the browser and calls its model through an adapter. This one sends each
// turn to the analyst route (app/api/ai/studio), which holds the Anthropic key, calls Claude and
// streams the reply back as the Messages API's own stream events.
//
// AG Studio keeps a conversation as a flat list of items (messages, reasoning, tool calls and
// their results); Claude takes alternating user and assistant messages. encodeRequest turns the
// first into the second, and decodeStream turns Claude's stream events into the events and
// response Studio reads.

import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaRawContentBlockDeltaEvent,
  BetaRawContentBlockStartEvent,
  BetaRefusalStopDetails,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type { AgAiEvent, AgAiOutputItem, AgLlmRequest, AgLlmResponse } from 'ag-studio';
import type { LlmStreamEvent, StreamRequest } from '@/lib/llm/stream';

// --- Turn ids ---------------------------------------------------------------------

// Every item a reply produces gets an id `${turnId}_${blockIndex}`, with a turn id of the form
// `turn_<uuid>`. Within a run Studio puts each tool call's result right after the call, so the
// turn id is how the calls of one reply are told apart from those of the next.

const TURN_ITEM_ID = /^(turn_[^_]+)_\d+$/;

/** The turn an item's id names, or undefined for an item that did not come from this adapter. */
const turnOf = (itemId: string): string | undefined => TURN_ITEM_ID.exec(itemId)?.[1];

// --- Encoding: AG Studio to Claude --------------------------------------------------

const textBlock = (text: string): BetaTextBlockParam => ({ type: 'text', text });

/** A tool call's arguments as the input object Claude sent. Anything else is sent as `{}`. */
function toolInput(args: string): Record<string, unknown> {
  try {
    const input: unknown = JSON.parse(args);
    return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Words asking for what a tool choice demands. Claude cannot be made to call a tool, so a turn
 * that must call one is asked to in the conversation instead.
 */
function toolChoiceRequest(choice: AgLlmRequest['toolChoice']): string | undefined {
  if (choice === undefined || choice === 'auto') return undefined;
  if (choice === 'none') return 'Answer without calling a tool.';
  if (choice === 'required') return 'Call one of your tools now.';
  return `Call the ${choice.name} tool now.`;
}

/**
 * The Messages API request for one AG Studio turn. Studio's instructions, and any system items in
 * the conversation, become the system prompt; each tool is sent by its JSON Schema, as an ordinary
 * (not strict) tool, since Studio checks every call's arguments itself and tells the model what
 * was wrong.
 *
 * Reasoning is left out: Studio keeps no signature to send it back with. Attachments are left out
 * too, as Studio's own harness does not carry them. The request never ends on an assistant
 * message, which Claude would read as the start of its own reply.
 */
export function encodeRequest(request: AgLlmRequest): StreamRequest {
  const system = request.instructions ? [request.instructions] : [];
  const messages: BetaMessageParam[] = [];

  const pushUser = (content: BetaContentBlockParam[]) => {
    const last = messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...content);
    else messages.push({ role: 'user', content });
  };

  // The reply being read, and the results that have come back for its calls.
  let assistant: { turn: string | undefined; content: (BetaTextBlockParam | BetaToolUseBlockParam)[] } | null = null;
  let results: BetaToolResultBlockParam[] = [];

  /** Sends the reply, then a result for each of its calls: the one Studio has, or else an error. */
  const flush = () => {
    if (assistant && assistant.content.length > 0) {
      messages.push({ role: 'assistant', content: assistant.content });
      const answers = assistant.content.flatMap((block): BetaToolResultBlockParam[] => {
        if (block.type !== 'tool_use') return [];
        const result = results.find((r) => r.tool_use_id === block.id);
        return [result ?? { type: 'tool_result', tool_use_id: block.id, content: 'The call did not run.', is_error: true }];
      });
      if (answers.length > 0) pushUser(answers);
    }
    assistant = null;
    results = [];
  };

  /** The reply an output item belongs to: the one being read, or a new one after its results. */
  const replyFor = (itemId: string) => {
    const turn = turnOf(itemId);
    const sameReply = assistant && (results.length === 0 || (turn !== undefined && turn === assistant.turn));
    if (!sameReply) {
      flush();
      assistant = { turn, content: [] };
    }
    return assistant!;
  };

  for (const item of request.input) {
    switch (item.type) {
      case 'message': {
        if (item.kind === 'input') {
          const texts = item.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : []));
          if (item.role === 'system') {
            system.push(...texts);
          } else {
            flush();
            if (texts.length > 0) pushUser(texts.map(textBlock));
          }
        } else {
          const texts = item.content.map((part) => (part.type === 'text' ? part.text : part.refusal)).filter(Boolean);
          replyFor(item.id).content.push(...texts.map(textBlock));
        }
        break;
      }
      case 'reasoning':
        replyFor(item.id);
        break;
      case 'function_call':
        replyFor(item.id).content.push({ type: 'tool_use', id: item.callId, name: item.name, input: toolInput(item.arguments) });
        break;
      case 'function_call_output':
        results.push({ type: 'tool_result', tool_use_id: item.callId, ...(item.output && { content: item.output }) });
        break;
    }
  }
  flush();

  const asked = toolChoiceRequest(request.toolChoice);
  if (messages.at(-1)?.role !== 'user') pushUser([textBlock(asked ?? 'Continue.')]);
  else if (asked) pushUser([textBlock(asked)]);

  const tools: BetaTool[] = (request.tools ?? [])
    .filter((tool) => tool.kind !== 'provided')
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { type: 'object', ...tool.parameters },
      // Arguments stream into Studio as they are written; Studio checks them before a tool runs.
      eager_input_streaming: true,
    }));

  return { system: system.join('\n\n'), messages, tools };
}

// --- Decoding: Claude to AG Studio --------------------------------------------------

/** What a turn produced besides its events: the response, or the failure that ended it. */
export interface TurnOutcome {
  response?: AgLlmResponse;
  error?: Error;
}

/** The events of the route's stream, read from its server-sent events. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<LlmStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = done ? '' : (frames.pop() ?? '');
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).replace(/^ /, ''))
          .join('\n');
        if (data) yield JSON.parse(data) as LlmStreamEvent;
      }
    }
  } finally {
    // A reader that stops early stops the response too.
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Block =
  | { kind: 'text' | 'thinking'; itemId: string; text: string; open: boolean }
  | { kind: 'tool_use'; itemId: string; callId: string; name: string; args: string; open: boolean };

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/** Stop reasons of a reply that was cut off. */
const CUT_OFF = new Set(['max_tokens', 'model_context_window_exceeded']);

/** Follows one reply's stream events, as Studio events, and builds the response they add up to. */
class ReplyDecoder {
  private message: { id: string; model: string; createdAt: number } | null = null;
  private readonly usage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  private readonly blocks = new Map<number, Block>();
  /** The index of the last fallback block: what comes before it is from a model that declined. */
  private lastFallback = -1;
  private stopReason: string | null = null;
  private stopDetails: BetaRefusalStopDetails | null = null;
  private stopped = false;
  private error: Error | undefined;

  constructor(
    private readonly turnId: string,
    private readonly now: () => number,
  ) {}

  /** The Studio events one stream event maps to. Anything not recognised is ignored. */
  read(event: LlmStreamEvent): AgAiEvent[] {
    switch (event.type) {
      case 'message_start':
        this.message = { id: event.message.id, model: event.message.model, createdAt: this.now() };
        this.takeUsage(event.message.usage);
        return [];
      case 'content_block_start':
        return this.open(event.index, event.content_block);
      case 'content_block_delta':
        return this.write(event.index, event.delta);
      case 'content_block_stop':
        return this.close(event.index);
      case 'message_delta':
        this.stopReason = event.delta.stop_reason;
        this.stopDetails = event.delta.stop_details ?? null;
        this.takeUsage(event.usage);
        return [];
      case 'message_stop':
        this.stopped = true;
        return [];
      case 'error':
        this.error ??= new Error(event.error.message);
        return [];
      default:
        return [];
    }
  }

  /**
   * Ends the turn: closes whatever is still open and settles `outcome`. A refused turn fails, so
   * none of its tool calls run; a cut-off turn is incomplete and keeps its text but not its calls,
   * whose input may be cut off too.
   */
  finish(outcome: TurnOutcome, failure?: unknown): AgAiEvent[] {
    const closing = [...this.blocks.keys()].flatMap((index) => this.close(index));
    if (failure !== undefined) this.error ??= failure instanceof Error ? failure : new Error(String(failure));
    if (this.error) {
      outcome.error = this.error;
    } else if (!this.message || !this.stopped) {
      outcome.error = new Error('The reply ended before it was complete.');
    } else if (this.stopReason === 'refusal') {
      const why = this.stopDetails?.explanation ?? this.stopDetails?.category;
      outcome.error = new Error(`The analyst declined this request${why ? `: ${why}` : '.'}`);
    } else {
      outcome.response = this.response(this.message);
    }
    return closing;
  }

  private takeUsage(usage: Partial<Record<keyof Usage, number | null>>) {
    for (const key of Object.keys(this.usage) as (keyof Usage)[]) {
      const count = usage[key];
      if (typeof count === 'number') this.usage[key] = count;
    }
  }

  private open(index: number, block: BetaRawContentBlockStartEvent['content_block']): AgAiEvent[] {
    const itemId = `${this.turnId}_${index}`;
    switch (block.type) {
      case 'text': {
        const opened: Block = { kind: 'text', itemId, text: '', open: true };
        this.blocks.set(index, opened);
        return [{ type: 'TEXT_MESSAGE_START', messageId: itemId, role: 'assistant' }, ...this.append(opened, block.text)];
      }
      case 'thinking': {
        const opened: Block = { kind: 'thinking', itemId, text: '', open: true };
        this.blocks.set(index, opened);
        return [{ type: 'REASONING_MESSAGE_START', messageId: itemId, role: 'reasoning' }, ...this.append(opened, block.thinking)];
      }
      case 'tool_use': {
        const opened: Block = { kind: 'tool_use', itemId, callId: block.id, name: block.name, args: '', open: true };
        this.blocks.set(index, opened);
        // A streamed call's input arrives in deltas; this start carries `{}`.
        const input = block.input as Record<string, unknown> | null;
        const written = input && Object.keys(input).length > 0 ? JSON.stringify(input) : '';
        return [{ type: 'TOOL_CALL_START', toolCallId: block.id, toolCallName: block.name }, ...this.append(opened, written)];
      }
      case 'fallback':
        this.lastFallback = index;
        if (this.message) this.message.model = block.to.model;
        return [];
      default:
        return [];
    }
  }

  private write(index: number, delta: BetaRawContentBlockDeltaEvent['delta']): AgAiEvent[] {
    const block = this.blocks.get(index);
    if (!block?.open) return [];
    if (delta.type === 'text_delta' && block.kind === 'text') return this.append(block, delta.text);
    if (delta.type === 'thinking_delta' && block.kind === 'thinking') return this.append(block, delta.thinking);
    if (delta.type === 'input_json_delta' && block.kind === 'tool_use') return this.append(block, delta.partial_json);
    return [];
  }

  /** Adds what Claude wrote to an open block. */
  private append(block: Block, written: string): AgAiEvent[] {
    if (!written) return [];
    switch (block.kind) {
      case 'text':
        block.text += written;
        return [{ type: 'TEXT_MESSAGE_CONTENT', messageId: block.itemId, delta: written }];
      case 'thinking':
        block.text += written;
        return [{ type: 'REASONING_MESSAGE_CONTENT', messageId: block.itemId, delta: written }];
      case 'tool_use':
        block.args += written;
        return [{ type: 'TOOL_CALL_ARGS', toolCallId: block.callId, delta: written }];
    }
  }

  private close(index: number): AgAiEvent[] {
    const block = this.blocks.get(index);
    if (!block?.open) return [];
    block.open = false;
    switch (block.kind) {
      case 'text':
        return [{ type: 'TEXT_MESSAGE_END', messageId: block.itemId }];
      case 'thinking':
        return [{ type: 'REASONING_MESSAGE_END', messageId: block.itemId }];
      case 'tool_use':
        return [{ type: 'TOOL_CALL_END', toolCallId: block.callId }];
    }
  }

  /**
   * The reply's text, reasoning and tool calls in the order Claude wrote them. Tool calls from a
   * model that declined before a fallback are left out, so they never run.
   */
  private response(message: { id: string; model: string; createdAt: number }): AgLlmResponse {
    const cutOff = CUT_OFF.has(this.stopReason ?? '');
    const output: AgAiOutputItem[] = [];
    for (const [index, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === 'text' && block.text) {
        output.push({
          id: block.itemId,
          kind: 'output',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'text', text: block.text, annotations: [] }],
        });
      } else if (block.kind === 'thinking' && block.text) {
        output.push({ id: block.itemId, kind: 'output', type: 'reasoning', summary: [{ type: 'summary', text: block.text }] });
      } else if (block.kind === 'tool_use' && !cutOff && index > this.lastFallback) {
        output.push({
          id: block.itemId,
          kind: 'output',
          type: 'function_call',
          callId: block.callId,
          name: block.name,
          arguments: block.args || '{}',
          status: 'completed',
        });
      }
    }
    // Claude counts cached input apart from input_tokens; Studio counts it as part of the input.
    const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = this.usage;
    const inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens;
    return {
      id: message.id,
      createdAt: message.createdAt,
      model: message.model,
      status: cutOff ? 'incomplete' : 'completed',
      ...(cutOff && { incompleteDetails: { reason: 'max_output_tokens' as const } }),
      output,
      usage: {
        inputTokens,
        outputTokens: output_tokens,
        totalTokens: inputTokens + output_tokens,
        cachedInputTokens: cache_read_input_tokens,
        cacheWriteTokens: cache_creation_input_tokens,
      },
    };
  }
}

/**
 * Studio's events for one reply, read from the route's stream events, as they arrive. When the
 * stream ends, `outcome` holds the response, or the error that ended the turn: an error event,
 * a refusal, a stream that stopped early, or a failure to read the stream at all.
 */
export async function* decodeStream(
  events: AsyncIterable<LlmStreamEvent>,
  outcome: TurnOutcome,
  opts: { turnId?: string; now?: () => number } = {},
): AsyncGenerator<AgAiEvent, void, undefined> {
  const decoder = new ReplyDecoder(opts.turnId ?? `turn_${crypto.randomUUID()}`, opts.now ?? Date.now);
  let failure: unknown;
  try {
    for await (const event of events) yield* decoder.read(event);
  } catch (error) {
    failure = error;
  }
  yield* decoder.finish(outcome, failure);
}
