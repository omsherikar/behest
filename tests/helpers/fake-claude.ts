import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages';

// A stand-in for the Messages API. Pass its `fetch` to `new Anthropic({ fetch })`: it answers each
// request with the next reply in order and records what was sent.

export type FakeClaudeRequest = {
  url: string;
  /** Header names are lowercased, as the Fetch API normalizes them. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * A reply with a numeric `status` is sent as that HTTP response, with `text` as the raw body or
 * else `body` JSON-encoded. Any other reply is a 200 JSON body.
 */
export type FakeClaudeReply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };

function isReply(response: object): response is FakeClaudeReply {
  return typeof (response as { status?: unknown }).status === 'number';
}

/**
 * Answers requests with `responses` in order. Each response carries a `request-id` header of
 * `req_fake_<n>` for the n-th request. A request after the last response rejects, which the SDK
 * reports as a connection error.
 */
export function fakeClaude(responses: object[]): { fetch: typeof fetch; requests: FakeClaudeRequest[] } {
  const remaining = [...responses];
  const requests: FakeClaudeRequest[] = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: JSON.parse(await request.text()),
    });

    const next = remaining.shift();
    if (next === undefined) throw new Error(`fakeClaude: no reply left for request ${requests.length}`);
    const reply = isReply(next) ? next : { status: 200, body: next };
    return new Response(reply.text ?? JSON.stringify(reply.body ?? null), {
      status: reply.status,
      headers: { 'content-type': 'application/json', 'request-id': `req_fake_${requests.length}`, ...reply.headers },
    });
  };

  return { fetch: fetchStub, requests };
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * One entry of `usage.iterations`: an attempt by one model, or by a model the API does not name
 * (`null`). Token counts default to zero.
 */
export function iteration(type: 'message' | 'fallback_message', model: string | null, tokens: Partial<Usage> = {}) {
  return {
    type,
    model,
    cache_creation: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...tokens,
  };
}

const textBlock = (text: string) => ({ type: 'text', text, citations: null });

/** A tool call the model makes. */
export type FakeToolUse = { id: string; name: string; input: unknown };

const toolUseBlocks = (toolUses: FakeToolUse[]) =>
  toolUses.map(({ id, name, input }) => ({ type: 'tool_use', id, name, input }));

/**
 * A Messages API response body from `model`. `json` is serialized into the text block; `text` is
 * used as is. Without either the reply has no text. `toolUses` follow the text as `tool_use`
 * blocks, and the stop reason then defaults to `tool_use` instead of `end_turn`. Usage defaults to
 * zero tokens.
 *
 * `fallbackFrom` makes it a reply rescued by server-side fallback: the declining model's `text`
 * and `toolUses` (if any), then a `fallback` block handing over to `model`, then the reply. Unless
 * `usage` gives `iterations`, they are the declining model's attempt with no tokens and a
 * `fallback_message` attempt by `model` with the top-level tokens.
 */
export function messageJson({
  text,
  json,
  toolUses = [],
  stop_reason = toolUses.length > 0 ? 'tool_use' : 'end_turn',
  usage,
  model = 'claude-opus-5-5',
  fallbackFrom,
}: {
  text?: string;
  json?: unknown;
  toolUses?: FakeToolUse[];
  stop_reason?: BetaStopReason;
  usage?: Partial<Usage> & { iterations?: object[] };
  model?: string;
  fallbackFrom?: { model: string; text?: string; toolUses?: FakeToolUse[] };
} = {}) {
  const body = text ?? (json === undefined ? undefined : JSON.stringify(json));
  const reply = [...(body === undefined ? [] : [textBlock(body)]), ...toolUseBlocks(toolUses)];
  const { iterations, ...counts } = usage ?? {};
  const tokens = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...counts };

  const content = fallbackFrom
    ? [
        ...(fallbackFrom.text === undefined ? [] : [textBlock(fallbackFrom.text)]),
        ...toolUseBlocks(fallbackFrom.toolUses ?? []),
        {
          type: 'fallback',
          from: { model: fallbackFrom.model },
          to: { model },
          trigger: { type: 'refusal', category: 'cyber' },
        },
        ...reply,
      ]
    : reply;
  const defaultIterations = fallbackFrom
    ? [iteration('message', fallbackFrom.model), iteration('fallback_message', model, tokens)]
    : null;

  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details:
      stop_reason === 'refusal'
        ? { type: 'refusal', category: 'cyber', explanation: 'The request was declined.' }
        : null,
    usage: { ...tokens, iterations: iterations ?? defaultIterations },
  };
}
