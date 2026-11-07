import { describe, expect, expectTypeOf, it } from 'vitest';
import { type AgentEvent, createAgentEventParser, readAgentEvents, type RunOutcome } from '@/lib/buyer-pages/agent-events';
import type { ProposalOutcome } from '@/lib/purchases/deps';

const outcome: RunOutcome = {
  purchaseId: '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7',
  verdict: 'ASK',
  status: 'awaiting_approval',
  reasons: ['Over $25.00, so you approve it.'],
  approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
  receiptId: null,
};

const events: AgentEvent[] = [
  { type: 'status', text: 'Your agent is looking for what you asked for.' },
  { type: 'tool', name: 'search_sellers', input: { query: 'turmeric' } },
  { type: 'proposal', outcome },
  { type: 'done', summary: 'I asked you to approve turmeric for $9.00.' },
  { type: 'error', message: 'Sign a mandate first.' },
];

/** Each event as the run route writes it: one frame, named by its type. */
const frame = (event: unknown) =>
  `event: ${(event as { type?: unknown } | null)?.type ?? 'message'}\ndata: ${JSON.stringify(event)}\n\n`;
const stream = events.map(frame).join('');

/** Every event `push` returns for the chunks, in order. */
function parseChunks(chunks: string[]): AgentEvent[] {
  const push = createAgentEventParser();
  return chunks.flatMap((chunk) => push(chunk));
}

/**
 * A byte stream that delivers `chunks` one at a time, then closes, or stays open when `open` is set,
 * as a run still going does. It records whether its reader cancelled it.
 */
function byteStream(chunks: Uint8Array[], { open = false } = {}) {
  const state = { cancelled: false };
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < chunks.length) controller.enqueue(chunks[next++]);
      else if (!open) controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

async function collect(body: ReadableStream<Uint8Array>): Promise<AgentEvent[]> {
  const read: AgentEvent[] = [];
  for await (const event of readAgentEvents(body)) read.push(event);
  return read;
}

describe('createAgentEventParser', () => {
  it('reads each event the run route sends, one frame per event', () => {
    expect(parseChunks([stream])).toEqual(events);
  });

  it('reads the same events however the text is split into chunks', () => {
    expect(parseChunks([...stream])).toEqual(events);
    const cuts = [7, 30, 31, 95, 200, stream.length - 1];
    const chunks = cuts.map((cut, i) => stream.slice(i === 0 ? 0 : cuts[i - 1], cut));
    chunks.push(stream.slice(cuts.at(-1)));
    expect(parseChunks(chunks)).toEqual(events);
  });

  it('returns an event only once the blank line that ends its frame has arrived', () => {
    const push = createAgentEventParser();
    const [first] = events.map(frame);
    expect(push(first.slice(0, -1))).toEqual([]);
    expect(push('\n')).toEqual([events[0]]);
  });

  it('accepts CRLF and CR line endings, a CRLF split across chunks included', () => {
    expect(parseChunks([stream.replaceAll('\n', '\r\n')])).toEqual(events);
    expect(parseChunks([stream.replaceAll('\n', '\r')])).toEqual(events);
    const crlf = frame(events[0]).replaceAll('\n', '\r\n');
    const split = crlf.indexOf('\r\n') + 1;
    expect(parseChunks([crlf.slice(0, split), crlf.slice(split)])).toEqual([events[0]]);
  });

  it('joins data spread over several lines and ignores comments and other fields', () => {
    const text = [
      ': keep-alive',
      'id: 7',
      'retry: 1000',
      'event: status',
      'data: {"type":"status",',
      'data:"text":"Still looking."}',
      '',
      '',
    ].join('\n');
    expect(parseChunks([text])).toEqual([{ type: 'status', text: 'Still looking.' }]);
  });

  it('skips a frame that is not JSON or not an event, and reads the frames after it', () => {
    const malformed = [
      'data: {"type":"status","text":\n\n',
      'data: not json at all\n\n',
      'data:\n\n',
      frame({ type: 'status' }),
      frame({ type: 'status', text: 42 }),
      frame({ type: 'reticulate', text: 'hello' }),
      frame({ type: 'tool', input: {} }),
      frame({ type: 'done' }),
      frame({ type: 'error', message: null }),
      frame({ type: 'proposal' }),
      frame({ type: 'proposal', outcome: { ...outcome, verdict: 'MAYBE' } }),
      frame({ type: 'proposal', outcome: { ...outcome, reasons: ['fine', 3] } }),
      frame({ type: 'proposal', outcome: { ...outcome, reasons: 'Over the limit' } }),
      frame({ type: 'proposal', outcome: { ...outcome, approveUrl: 7 } }),
      frame({ type: 'proposal', outcome: { ...outcome, receiptId: undefined } }),
      frame({ type: 'proposal', outcome: { ...outcome, purchaseId: 12 } }),
      frame({ type: 'proposal', outcome: { ...outcome, status: null } }),
      frame(null),
      frame([events[0]]),
      'data: "status"\n\n',
    ];
    expect(parseChunks([...malformed, frame(events[3])])).toEqual([events[3]]);
  });

  it('keeps only the fields an event defines', () => {
    const extra = { type: 'proposal', outcome: { ...outcome, cart: { totalCents: 1 } }, html: '<b>hi</b>' };
    expect(parseChunks([frame(extra)])).toEqual([{ type: 'proposal', outcome }]);
    expect(parseChunks([frame({ type: 'done', summary: 'Done.', extra: true })])).toEqual([{ type: 'done', summary: 'Done.' }]);
  });

  it('reads a tool event whatever input the agent gave', () => {
    const tool = { type: 'tool', name: 'propose_purchase', input: [1, 'two'] };
    expect(parseChunks([frame(tool), frame({ type: 'tool', name: 'get_product' })])).toEqual([
      tool,
      { type: 'tool', name: 'get_product', input: undefined },
    ]);
  });
});

describe('readAgentEvents', () => {
  it('reads the events from a byte stream, characters split across chunks included', async () => {
    const withAccent = [...events, { type: 'done', summary: 'Café crème, ₹ and 🌶 sorted.' }] as AgentEvent[];
    const bytes = new TextEncoder().encode(withAccent.map(frame).join(''));
    const chunks = Array.from({ length: Math.ceil(bytes.length / 5) }, (_, i) => bytes.slice(i * 5, i * 5 + 5));
    const { body } = byteStream(chunks);
    expect(await collect(body)).toEqual(withAccent);
  });

  it('cancels the stream when the reader stops early', async () => {
    const { body, state } = byteStream([new TextEncoder().encode(stream)], { open: true });
    for await (const event of readAgentEvents(body)) {
      expect(event).toEqual(events[0]);
      break;
    }
    expect(state.cancelled).toBe(true);
  });

  it('ends quietly on a stream that closes mid-frame', async () => {
    const { body } = byteStream([new TextEncoder().encode(`${frame(events[0])}data: {"type":"done"`)]);
    expect(await collect(body)).toEqual([events[0]]);
  });
});

it("fits every outcome the purchase flow returns, so the route's events read as these", () => {
  expectTypeOf<ProposalOutcome>().toExtend<RunOutcome>();
});
