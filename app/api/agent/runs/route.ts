import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { type AgentEvent, RUN_FAILED, runShoppingAgent } from '@/lib/agent/run';
import { appDb, demoBuyerId, llmDeps, purchaseDeps } from '@/lib/app-deps';
import { searchMarket } from '@/lib/channel3/client';
import { readBody } from '@/lib/http/read-body';
import { type Release, takeSlot } from '@/lib/inflight';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Runs the shopping agent on what the buyer asked for and streams its progress to the buyer's page
// as server-sent events, one AgentEvent per frame. A buyer has at most one run going at a time. When
// the buyer goes away, the run stops at its next turn boundary: a proposal already running is left
// to finish, because money may be moving, and its purchase records how it ended.

const ROUTE = 'agent_run';

/** The largest body accepted, in bytes: room for a request of 2,000 characters of ordinary text. */
const MAX_BODY_BYTES = 8 * 1024;
const MAX_REQUEST_LENGTH = 2_000;
/** How many runs one buyer may have going at once. */
const MAX_RUNS_IN_FLIGHT = 1;

const NOT_JSON = 'Send your request as JSON.';
const NO_REQUEST = 'Tell your agent what to buy first.';

/** The buyer's request, as typed: one line or several, sent to the agent as it is. */
const RunRequest = z.object(
  {
    request: z
      .string({ error: NO_REQUEST })
      .max(MAX_REQUEST_LENGTH, { error: 'Keep your request to 2,000 characters or fewer.' })
      .refine((text) => text.trim() !== '', { error: NO_REQUEST }),
  },
  { error: NOT_JSON },
);

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

type Run = (onEvent: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>;

/**
 * The run's events as server-sent events. The run is told to stop when the reader cancels the
 * stream or when `request`'s signal aborts, which is how Next.js reports a client that went away
 * even when it never cancels this stream; nothing more is sent after either. What the run throws is
 * logged and sent as one error event with a fixed message. `release` gives the buyer's slot back
 * once the run has ended, however it ends, and not before: a stopped run is still in flight until
 * it reaches its turn boundary.
 */
function serverSentEvents(run: Run, release: Release, request: Request): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  // Whether the stream can still take events: false once the reader cancelled it or it closed.
  let open = true;

  return new ReadableStream({
    start(controller) {
      const send = (event: AgentEvent) => {
        if (!open || stop.signal.aborted) return;
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      };
      // The listener also keeps `request` reachable while the run goes on: its signal follows
      // Next.js's only while the request is.
      if (request.signal.aborted) stop.abort();
      else request.signal.addEventListener('abort', onAbort, { once: true });

      void (async () => {
        try {
          await run(send, stop.signal);
        } catch (failure) {
          // Misconfiguration or the database: the details go to the server log, not the browser.
          console.error('[agent] The run failed:', failure);
          send({ type: 'error', message: RUN_FAILED });
        } finally {
          request.signal.removeEventListener('abort', onAbort);
          release();
          if (open) {
            open = false;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      open = false;
      stop.abort();
    },
  });
}

/** `POST { request }`: runs the shopping agent for the buyer and streams its events. */
export async function POST(request: NextRequest) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:buyer`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, NOT_JSON);
  }
  const parsed = RunRequest.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0].message);

  const buyerId = await demoBuyerId(appDb());
  const release = takeSlot(`${ROUTE}:${buyerId}`, MAX_RUNS_IN_FLIGHT);
  if (!release) return error(429, 'Your agent is already shopping. Wait for it to finish.');

  const run: Run = async (onEvent, signal) => {
    // Built inside the run, so a missing setting ends it with an error event and frees the slot.
    const deps = {
      ...llmDeps(),
      purchases: await purchaseDeps(),
      // Without a key, the agent is told that market prices are not available.
      ...(process.env.CHANNEL3_API_KEY?.trim() ? { search: searchMarket } : {}),
    };
    await runShoppingAgent(deps, { buyerId, request: parsed.data.request, onEvent, signal });
  };
  return new Response(serverSentEvents(run, release, request), {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
  });
}
