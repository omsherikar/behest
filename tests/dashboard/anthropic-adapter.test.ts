import type {
  AgAiConversationItem,
  AgAiInputMessage,
  AgAiOutputMessage,
  AgAiReasoningItem,
  AgAiToolCall,
  AgAiToolCallResult,
  AgAiToolSchema,
  AgLlmRequest,
} from 'ag-studio';
import { describe, expect, it } from 'vitest';
import { decodeStream, encodeRequest, readSse, type TurnOutcome } from '@/app/dashboard/studio/anthropic-adapter';
import type { LlmStreamEvent } from '@/lib/llm/stream';
import { recordedStream, sseEvents } from '@/tests/helpers/sse';

// --- Conversation items, as AG Studio holds them ----------------------------------

const user = (text: string, id = 'user-1'): AgAiInputMessage => ({
  id,
  kind: 'input',
  type: 'message',
  role: 'user',
  content: [{ type: 'text', text }],
  status: 'completed',
});

const said = (id: string, text: string): AgAiOutputMessage => ({
  id,
  kind: 'output',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'text', text, annotations: [] }],
});

const thought = (id: string, text: string): AgAiReasoningItem => ({
  id,
  kind: 'output',
  type: 'reasoning',
  summary: [{ type: 'summary', text }],
});

const called = (id: string, callId: string, args: string, name = 'execute_query'): AgAiToolCall => ({
  id,
  kind: 'output',
  type: 'function_call',
  callId,
  name,
  arguments: args,
  status: 'completed',
});

const answered = (callId: string, output: string): AgAiToolCallResult => ({
  type: 'function_call_output',
  callId,
  output,
  status: 'completed',
});

const QUERY_TOOL: AgAiToolSchema = {
  name: 'execute_query',
  description: 'Run a query over the dashboard data.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'object' } },
    required: ['query'],
    additionalProperties: false,
  },
};

const request = (input: AgAiConversationItem[], extra: Partial<AgLlmRequest> = {}): AgLlmRequest => ({
  input,
  instructions: 'You are the dashboard analyst.',
  tools: [QUERY_TOOL],
  responseFormat: { type: 'text' },
  ...extra,
});

const text = (value: string) => ({ type: 'text', text: value });
const toolUse = (id: string, input: unknown, name = 'execute_query') => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });

// --- Encoding ---------------------------------------------------------------------

describe('encodeRequest', () => {
  it('sends the instructions as the system prompt, the conversation as messages and each tool by its schema', () => {
    expect(encodeRequest(request([user('Which purchases needed approval this week and why?')]))).toEqual({
      system: 'You are the dashboard analyst.',
      messages: [{ role: 'user', content: [text('Which purchases needed approval this week and why?')] }],
      tools: [
        {
          name: 'execute_query',
          description: 'Run a query over the dashboard data.',
          input_schema: QUERY_TOOL.parameters,
          eager_input_streaming: true,
        },
      ],
    });
  });

  it("puts one turn's tool calls in one assistant message and their results in the next user message", () => {
    // Within a run, Studio follows each call with its result: call, result, call, result.
    const input = [
      user('Which purchases needed approval this week and why?'),
      thought('turn_a_0', 'Two queries will answer this.'),
      said('turn_a_1', 'Looking at the purchases and their reasons.'),
      called('turn_a_2', 'toolu_1', '{"query":{"table":"purchases"}}'),
      answered('toolu_1', 'Returned 2 rows.'),
      called('turn_a_3', 'toolu_2', '{"query":{"table":"gateOutcomes"}}'),
      answered('toolu_2', 'Returned 5 rows.'),
      called('turn_b_0', 'toolu_3', '{"query":{"table":"mandates"}}'),
      answered('toolu_3', 'Returned 1 row.'),
    ];

    expect(encodeRequest(request(input)).messages).toEqual([
      { role: 'user', content: [text('Which purchases needed approval this week and why?')] },
      {
        role: 'assistant',
        content: [
          text('Looking at the purchases and their reasons.'),
          toolUse('toolu_1', { query: { table: 'purchases' } }),
          toolUse('toolu_2', { query: { table: 'gateOutcomes' } }),
        ],
      },
      { role: 'user', content: [toolResult('toolu_1', 'Returned 2 rows.'), toolResult('toolu_2', 'Returned 5 rows.')] },
      { role: 'assistant', content: [toolUse('toolu_3', { query: { table: 'mandates' } })] },
      { role: 'user', content: [toolResult('toolu_3', 'Returned 1 row.')] },
    ]);
  });

  it('reads turns from earlier conversations, whose items carry ids of their own', () => {
    // Studio rebuilds earlier runs with every call of a message ahead of every result.
    const input = [
      user('Which purchases needed approval this week?', 'user-1'),
      said('assistant-1', 'Checking.'),
      called('toolu_1', 'toolu_1', '{"query":{"table":"purchases"}}'),
      called('toolu_2', 'toolu_2', '{"query":{"table":"gateOutcomes"}}'),
      answered('toolu_1', 'Returned 2 rows.'),
      answered('toolu_2', 'Returned 5 rows.'),
      said('assistant-2', 'Two purchases needed approval.'),
      user('And last week?', 'user-2'),
    ];

    expect(encodeRequest(request(input)).messages).toEqual([
      { role: 'user', content: [text('Which purchases needed approval this week?')] },
      {
        role: 'assistant',
        content: [
          text('Checking.'),
          toolUse('toolu_1', { query: { table: 'purchases' } }),
          toolUse('toolu_2', { query: { table: 'gateOutcomes' } }),
        ],
      },
      { role: 'user', content: [toolResult('toolu_1', 'Returned 2 rows.'), toolResult('toolu_2', 'Returned 5 rows.')] },
      { role: 'assistant', content: [text('Two purchases needed approval.')] },
      { role: 'user', content: [text('And last week?')] },
    ]);
  });

  it('leaves reasoning out, since it carries no signature to send back', () => {
    const input = [user('How much of my budget is left?'), thought('turn_a_0', 'One query.'), said('turn_a_1', '$12 is left.')];

    const { messages } = encodeRequest(request(input, { toolChoice: 'auto' }));

    expect(messages.slice(0, 2)).toEqual([
      { role: 'user', content: [text('How much of my budget is left?')] },
      { role: 'assistant', content: [text('$12 is left.')] },
    ]);
  });

  it('asks for a named tool in words and never ends on an assistant message, since Claude cannot be made to call one', () => {
    // Studio's retry to make a delegated run finish: the last turn answered without calling the tool.
    const input = [user('Summarise the blocked purchases.'), said('turn_a_0', 'Three were blocked.')];

    expect(encodeRequest(request(input, { toolChoice: { name: 'complete_task' } })).messages).toEqual([
      { role: 'user', content: [text('Summarise the blocked purchases.')] },
      { role: 'assistant', content: [text('Three were blocked.')] },
      { role: 'user', content: [text('Call the complete_task tool now.')] },
    ]);
    expect(encodeRequest(request(input, { toolChoice: 'required' })).messages.at(-1)).toEqual({
      role: 'user',
      content: [text('Call one of your tools now.')],
    });
    expect(encodeRequest(request(input)).messages.at(-1)).toEqual({ role: 'user', content: [text('Continue.')] });
  });

  it('adds the request for a tool to the last user message when the conversation already ends with one', () => {
    const input = [user('Summarise the blocked purchases.'), called('turn_a_0', 'toolu_1', '{}'), answered('toolu_1', 'Done.')];

    expect(encodeRequest(request(input, { toolChoice: 'none' })).messages.at(-1)).toEqual({
      role: 'user',
      content: [toolResult('toolu_1', 'Done.'), text('Answer without calling a tool.')],
    });
  });

  it('answers a call that never got a result and drops a result whose call is gone', () => {
    // A run stopped while its tool ran: the call is in the history with no result.
    const input = [
      user('Add a chart of revenue by day.'),
      called('toolu_1', 'toolu_1', '{"type":"chart"}', 'add_widget'),
      answered('toolu_9', 'An orphaned result.'),
      user('Never mind.', 'user-2'),
    ];

    expect(encodeRequest(request(input)).messages).toEqual([
      { role: 'user', content: [text('Add a chart of revenue by day.')] },
      { role: 'assistant', content: [toolUse('toolu_1', { type: 'chart' }, 'add_widget')] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'The call did not run.', is_error: true },
          text('Never mind.'),
        ],
      },
    ]);
  });

  it('sends arguments that are not a JSON object as an empty input', () => {
    const input = [
      user('Refresh.'),
      called('turn_a_0', 'toolu_1', ''),
      called('turn_a_1', 'toolu_2', '{"query": {"tab'),
      called('turn_a_2', 'toolu_3', '[1, 2]'),
      answered('toolu_1', 'a'),
      answered('toolu_2', 'b'),
      answered('toolu_3', 'c'),
    ];

    expect(encodeRequest(request(input)).messages[1]).toEqual({
      role: 'assistant',
      content: [toolUse('toolu_1', {}), toolUse('toolu_2', {}), toolUse('toolu_3', {})],
    });
  });

  it('adds system items to the system prompt and skips empty text and attachments', () => {
    const system: AgAiInputMessage = { ...user('Answer in dollars.', 'system-1'), role: 'system' };
    const withImage: AgAiInputMessage = {
      ...user('', 'user-1'),
      content: [
        { type: 'text', text: '' },
        { type: 'image', detail: 'auto', imageUrl: 'https://example.com/chart.png' },
        { type: 'text', text: 'What is this?' },
      ],
    };
    const input: AgAiConversationItem[] = [
      system,
      withImage,
      said('turn_a_0', ''),
      called('turn_a_1', 'toolu_1', '{}'),
      answered('toolu_1', ''),
    ];

    expect(encodeRequest(request(input))).toMatchObject({
      system: 'You are the dashboard analyst.\n\nAnswer in dollars.',
      messages: [
        { role: 'user', content: [text('What is this?')] },
        { role: 'assistant', content: [toolUse('toolu_1', {})] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      ],
    });
  });

  it('sends a tool schema without a type as an object, and leaves out provider-hosted tools', () => {
    const tools: AgAiToolSchema[] = [
      { name: 'rename_thread', description: 'Rename the conversation.', parameters: { properties: { title: { type: 'string' } } } },
      { name: 'web_search', description: 'Search the web.', parameters: {}, kind: 'provided', provider: { type: 'web_search' } },
    ];

    expect(encodeRequest(request([user('Hi')], { tools })).tools).toEqual([
      {
        name: 'rename_thread',
        description: 'Rename the conversation.',
        input_schema: { type: 'object', properties: { title: { type: 'string' } } },
        eager_input_streaming: true,
      },
    ]);
  });
});

// --- Decoding ---------------------------------------------------------------------

/** `text` as a response body, sent in chunks of `size` bytes. */
function body(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
      controller.close();
    },
  });
}

async function* each<T>(items: T[]): AsyncGenerator<T> {
  yield* items;
}

/** The recorded stream `name`, as the events the analyst route sends. */
const recorded = (name: string) => sseEvents(recordedStream(name)) as LlmStreamEvent[];

async function decode(events: LlmStreamEvent[]) {
  const outcome: TurnOutcome = {};
  const decoded = [];
  for await (const event of decodeStream(each(events), outcome, { turnId: 'turn_t', now: () => 1000 })) {
    decoded.push(event);
  }
  return { events: decoded, outcome };
}

const THINKING = 'Two rows came back, both asked because the total was over the ask threshold.';
const ANSWER = 'Two purchases needed approval this week. Both were over the $50 amount above which the agent asks.';
const QUERY_ARGS = '{"query": {"fields": ["purchases.id", "purchases.request"]}}';

/** `events` with the reply's stop reason, and its stop details, changed. */
const stoppedWith = (events: LlmStreamEvent[], stop_reason: string, stop_details: object | null = null) =>
  events.map((event) =>
    event.type === 'message_delta' ? { ...event, delta: { ...event.delta, stop_reason, stop_details } } : event,
  ) as LlmStreamEvent[];

describe('readSse', () => {
  it('reads every event of the stream, however the body is split', async () => {
    const stream = recordedStream('tool-turn');
    for (const size of [1, 5, 64, stream.length]) {
      const events = [];
      for await (const event of readSse(body(stream, size))) events.push(event);
      expect(events).toEqual(sseEvents(stream));
    }
  });

  it('keeps characters whose bytes are split between chunks', async () => {
    const events = [];
    for await (const event of readSse(body('data: {"type":"note","text":"Café ₹"}\n\n', 1))) events.push(event);
    expect(events).toEqual([{ type: 'note', text: 'Café ₹' }]);
  });
});

describe('decodeStream', () => {
  it('turns a text reply into reasoning and message events and a completed response', async () => {
    const { events, outcome } = await decode(recorded('text-turn'));

    expect(events).toEqual([
      { type: 'REASONING_MESSAGE_START', messageId: 'turn_t_0', role: 'reasoning' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'turn_t_0', delta: THINKING },
      { type: 'REASONING_MESSAGE_END', messageId: 'turn_t_0' },
      { type: 'TEXT_MESSAGE_START', messageId: 'turn_t_1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'turn_t_1', delta: 'Two purchases needed approval this week. ' },
      {
        type: 'TEXT_MESSAGE_CONTENT',
        messageId: 'turn_t_1',
        delta: 'Both were over the $50 amount above which the agent asks.',
      },
      { type: 'TEXT_MESSAGE_END', messageId: 'turn_t_1' },
    ]);
    expect(outcome).toEqual({
      response: {
        id: 'msg_text_turn',
        createdAt: 1000,
        model: 'claude-opus-5-5',
        status: 'completed',
        output: [
          { id: 'turn_t_0', kind: 'output', type: 'reasoning', summary: [{ type: 'summary', text: THINKING }] },
          {
            id: 'turn_t_1',
            kind: 'output',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'text', text: ANSWER, annotations: [] }],
          },
        ],
        usage: { inputTokens: 1800, outputTokens: 62, totalTokens: 1862, cachedInputTokens: 0, cacheWriteTokens: 0 },
      },
    });
  });

  it('streams a tool call as its input is written and returns it as a call for Studio to run', async () => {
    const { events, outcome } = await decode(recorded('tool-turn'));

    expect(events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'turn_t_0', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'turn_t_0', delta: "I'll look up this week's purchases that needed approval." },
      { type: 'TEXT_MESSAGE_END', messageId: 'turn_t_0' },
      { type: 'TOOL_CALL_START', toolCallId: 'toolu_query', toolCallName: 'execute_query' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'toolu_query', delta: '{"query": {"fields": ["purchases.id"' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'toolu_query', delta: ', "purchases.request"]}}' },
      { type: 'TOOL_CALL_END', toolCallId: 'toolu_query' },
    ]);
    expect(outcome.response?.status).toBe('completed');
    expect(outcome.response?.output).toEqual([
      expect.objectContaining({ id: 'turn_t_0', type: 'message' }),
      {
        id: 'turn_t_1',
        kind: 'output',
        type: 'function_call',
        callId: 'toolu_query',
        name: 'execute_query',
        arguments: QUERY_ARGS,
        status: 'completed',
      },
    ]);
  });

  it('decodes a turn that encodes back to the reply Claude sent', async () => {
    const { outcome } = await decode(recorded('tool-turn'));
    const output = outcome.response?.output ?? [];

    const { messages } = encodeRequest({
      input: [user('Which purchases needed approval this week and why?'), ...output, answered('toolu_query', 'Returned 2 rows.')],
      responseFormat: { type: 'text' },
    });

    expect(messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [text("I'll look up this week's purchases that needed approval."), toolUse('toolu_query', JSON.parse(QUERY_ARGS))],
      },
      { role: 'user', content: [toolResult('toolu_query', 'Returned 2 rows.')] },
    ]);
  });

  it('ends the turn with the error an error event carries, closing what was open', async () => {
    const { events, outcome } = await decode([
      ...recorded('error-turn').slice(0, -1),
      { type: 'error', error: { type: 'api_error', message: 'Overloaded' } },
    ]);

    expect(events).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'turn_t_0', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'turn_t_0', delta: 'Looking at' },
      { type: 'TEXT_MESSAGE_END', messageId: 'turn_t_0' },
    ]);
    expect(outcome).toEqual({ error: new Error('Overloaded') });
  });

  it('ends the turn with the spend cap when the route sends nothing else', async () => {
    const { events, outcome } = await decode([
      { type: 'error', error: { type: 'spend_cap', message: 'Spent $5 of the $5 daily model budget' } },
    ]);

    expect(events).toEqual([]);
    expect(outcome).toEqual({ error: new Error('Spent $5 of the $5 daily model budget') });
  });

  it('fails a refused turn, so none of its tool calls run', async () => {
    const refused = stoppedWith(recorded('tool-turn'), 'refusal', {
      type: 'refusal',
      category: 'cyber',
      explanation: 'The request was declined.',
    });

    expect((await decode(refused)).outcome).toEqual({
      error: new Error('The analyst declined this request: The request was declined.'),
    });
  });

  it('returns a cut-off turn as incomplete, without the tool call it was writing', async () => {
    const { outcome } = await decode(stoppedWith(recorded('tool-turn'), 'max_tokens'));

    expect(outcome.response).toMatchObject({ status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } });
    expect(outcome.response?.output.map((item) => item.type)).toEqual(['message']);
  });

  it('fails a turn whose stream stops before the reply is complete', async () => {
    const { events, outcome } = await decode(recorded('text-turn').slice(0, 7));

    expect(events.at(-1)).toEqual({ type: 'TEXT_MESSAGE_END', messageId: 'turn_t_1' });
    expect(outcome).toEqual({ error: new Error('The reply ended before it was complete.') });
  });

  it('keeps only the tool calls made after a fallback, and names the model that took over', async () => {
    const all = recorded('tool-turn');
    const [start, textStart, textDelta, textStop, ...call] = all;
    const at = (index: number, events: LlmStreamEvent[]) => events.map((event) => ({ ...event, index }));
    const events = [
      start,
      ...at(0, call.slice(0, 5)),
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'fallback',
          from: { model: 'claude-opus-5-5' },
          to: { model: 'claude-opus-4-8' },
          trigger: { type: 'refusal' },
        },
      },
      { type: 'content_block_stop', index: 1 },
      ...at(2, [textStart, textDelta, textStop]),
      ...all.slice(-2),
    ] as LlmStreamEvent[];

    const { outcome } = await decode(events);

    expect(outcome.response?.model).toBe('claude-opus-4-8');
    expect(outcome.response?.output).toEqual([expect.objectContaining({ id: 'turn_t_2', type: 'message' })]);
  });

  it('counts cached input in the turn\'s input tokens', async () => {
    const events = recorded('text-turn').map((event) =>
      event.type === 'message_delta'
        ? { ...event, usage: { output_tokens: 62, input_tokens: 300, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 } }
        : event,
    ) as LlmStreamEvent[];

    expect((await decode(events)).outcome.response?.usage).toEqual({
      inputTokens: 1800,
      outputTokens: 62,
      totalTokens: 1862,
      cachedInputTokens: 1200,
      cacheWriteTokens: 300,
    });
  });
});
