import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages';

// A stand-in for the Messages API. Pass its `fetch` to `new Anthropic({ fetch })`: it answers each
// request with the next reply in order and records what was sent.

export type FakeClaudeRequest = {
  url: string;
  /** Header names are lowercased, as the Fetch API normalizes them. */
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/** A reply with a numeric `status` is sent as that HTTP response; any other reply is a 200 JSON body. */
export type FakeClaudeReply = { status: number; body?: unknown; headers?: Record<string, string> };

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
    return new Response(JSON.stringify(reply.body ?? null), {
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
 * A Messages API response body. `json` is serialized into the text block; `text` is used as is.
 * Without either the message has no content. Usage defaults to zero tokens.
 */
export function messageJson({
  text,
  json,
  stop_reason = 'end_turn',
  usage,
}: { text?: string; json?: unknown; stop_reason?: BetaStopReason; usage?: Partial<Usage> } = {}) {
  const body = text ?? (json === undefined ? undefined : JSON.stringify(json));
  return {
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: body === undefined ? [] : [{ type: 'text', text: body, citations: null }],
    stop_reason,
    stop_sequence: null,
    stop_details:
      stop_reason === 'refusal'
        ? { type: 'refusal', category: 'cyber', explanation: 'The request was declined.' }
        : null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  };
}
