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
import { encodeRequest } from '@/app/dashboard/studio/anthropic-adapter';

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
