import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages';
import { connection, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { createClaude } from '@/lib/llm/client';
import { type LlmStreamEvent, type StreamRequest, streamReply } from '@/lib/llm/stream';
import { rateLimit, STUDIO_ANALYST_LIMIT } from '@/lib/ratelimit';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

// The dashboard analyst. AG Studio's adapter (app/dashboard/studio/anthropic-adapter.ts) runs in
// the browser and posts each turn here as a Messages API system prompt, messages and tools. This
// calls Claude on the studio_analyst route, which picks the model and effort, and streams Claude's
// own stream events back as server-sent events. The Anthropic key never leaves the server.
//
// The analyst works only with what the persona's dashboard already holds: its tools run in the
// browser against Studio's data. So a turn may carry only text, calls of the dashboard's own tools
// and their results; anything that would have Claude fetch a document or run a hosted tool is
// refused.

const ROUTE = 'studio_analyst';

/** The largest turn accepted, in bytes: about a quarter of a million tokens. */
const MAX_BODY_BYTES = 1_000_000;

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A content block the analyst may send: text, a tool call or a tool result, and only their own fields. */
function contentBlock(value: unknown): BetaContentBlockParam | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : null;
    case 'tool_use':
      return typeof value.id === 'string' && typeof value.name === 'string' && isObject(value.input)
        ? { type: 'tool_use', id: value.id, name: value.name, input: value.input }
        : null;
    case 'tool_result': {
      const { tool_use_id, content, is_error } = value;
      if (typeof tool_use_id !== 'string') return null;
      if (content !== undefined && typeof content !== 'string') return null;
      if (is_error !== undefined && typeof is_error !== 'boolean') return null;
      return {
        type: 'tool_result',
        tool_use_id,
        ...(content !== undefined && { content }),
        ...(is_error !== undefined && { is_error }),
      };
    }
    default:
      return null;
  }
}

function message(value: unknown): BetaMessageParam | null {
  if (!isObject(value) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  if (typeof value.content === 'string') return { role: value.role, content: value.content };
  if (!Array.isArray(value.content)) return null;
  const content = value.content.map(contentBlock);
  return content.every((block) => block !== null) ? { role: value.role, content } : null;
}

/** One of the dashboard's own tools, described by a JSON Schema. Hosted tools have no schema. */
function tool(value: unknown): BetaTool | null {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.description !== 'string') return null;
  if (!isObject(value.input_schema) || value.input_schema.type !== 'object') return null;
  return {
    name: value.name,
    description: value.description,
    input_schema: value.input_schema as BetaTool.InputSchema,
    ...(value.eager_input_streaming === true && { eager_input_streaming: true }),
  };
}

/** The turn in a request body, rebuilt from the fields the analyst may send, or why it is refused. */
function readTurn(text: string): { ok: true; turn: StreamRequest } | { ok: false; message: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, message: 'The request must be JSON.' };
  }
  if (!isObject(body) || typeof body.system !== 'string' || !Array.isArray(body.messages) || !Array.isArray(body.tools)) {
    return { ok: false, message: 'The request needs a system prompt, messages and tools.' };
  }
  const messages = body.messages.map(message);
  if (messages.length === 0 || messages.some((m) => m === null)) {
    return { ok: false, message: 'Messages may only hold text, tool calls and tool results.' };
  }
  const tools = body.tools.map(tool);
  if (tools.some((t) => t === null)) {
    return { ok: false, message: 'Each tool needs a name, a description and an object input schema.' };
  }
  return {
    ok: true,
    turn: { system: body.system, messages: messages as BetaMessageParam[], tools: tools as BetaTool[] },
  };
}

/** Studio's instructions, and the date: "this week" means nothing to the model without it. */
function withToday(system: string, now: Date): string {
  const today = `Today is ${now.toISOString().slice(0, 10)} (UTC). Weeks start on Monday.`;
  return system ? `${system}\n\n${today}` : today;
}

/** The client's address as the hosting platform reports it, which sets both headers itself. */
function clientAddress(request: NextRequest): string {
  return request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
}

/**
 * The request body as text, or null when it is over MAX_BODY_BYTES. A body that declares a larger
 * length is refused unread; any other is counted as it arrives, so one that misstates or leaves
 * out its length is stopped as soon as it passes the limit.
 */
async function readBody(request: NextRequest): Promise<string | null> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The events as server-sent events. A reader that goes away stops the reply. */
function serverSentEvents(events: AsyncGenerator<LlmStreamEvent, void, undefined>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frame = (event: LlmStreamEvent) => encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) controller.close();
        else controller.enqueue(frame(next.value));
      } catch (failure) {
        // Misconfiguration or the database: the details go to the server log, not the browser.
        console.error('[analyst] The reply failed:', failure);
        controller.enqueue(frame({ type: 'error', error: { type: 'api_error', message: 'The analyst failed. Try again later.' } }));
        controller.close();
      }
    },
    async cancel() {
      await events.return();
    },
  });
}

/** `POST` one AG Studio turn: streams Claude's reply as server-sent events. */
export async function POST(request: NextRequest) {
  // Reads the database on every request, never at build time.
  await connection();

  const persona = await getPersona(request.cookies.get(SESSION_COOKIE)?.value);
  if (!persona) return error(401, 'Pick a persona on the home page first.');
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:${persona}`, STUDIO_ANALYST_LIMIT)) {
    return error(429, 'Too many questions at once. Try again in a minute.');
  }

  const text = await readBody(request);
  if (text === null) return error(413, 'This conversation is too long for the analyst. Start a new one.');
  const read = readTurn(text);
  if (!read.ok) return error(400, read.message);

  const now = () => new Date();
  const events = streamReply(
    { db: getDb(), claude: createClaude(), now },
    ROUTE,
    { ...read.turn, system: withToday(read.turn.system, now()) },
    { signal: request.signal },
  );
  return new Response(serverSentEvents(events), {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  });
}
