// AG Studio's AI runs in the browser and calls its model through an adapter. This one sends each
// turn to the analyst route (app/api/ai/studio), which holds the Anthropic key, calls Claude and
// streams the reply back as the Messages API's own stream events.
//
// AG Studio keeps a conversation as a flat list of items (messages, reasoning, tool calls and
// their results); Claude takes alternating user and assistant messages. encodeRequest turns the
// first into the second.

import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type { AgLlmRequest } from 'ag-studio';
import type { StreamRequest } from '@/lib/llm/stream';

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
