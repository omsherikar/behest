// The bridge between PayPal's official Agent Toolkit and Claude. The evidence agent may only read
// disputes, orders and shipment tracking, so only the tools named in READ_ONLY_TOOLS ever become Claude
// tools, whatever the toolkit offers. That list, not the toolkit configuration, is the guard: the
// toolkit's handleToolCall runs any tool it knows by name without checking its configuration.
// Everything a tool returns is third-party data, and a dispute can hold text written to steer the agent,
// so each result is wrapped in an <untrusted> tag the content cannot close, and capped in length.

import { randomUUID } from 'node:crypto';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';

/** The only PayPal tools the evidence agent is given. Each one only reads from PayPal. */
export const READ_ONLY_TOOLS = ['list_disputes', 'get_dispute', 'get_order', 'get_shipment_tracking'] as const;

/** The toolkit actions behind READ_ONLY_TOOLS, so the toolkit builds no other tools to begin with. */
const CONFIGURATION = {
  actions: { disputes: { list: true, get: true }, orders: { get: true }, shipment: { get: true } },
  context: { sandbox: true },
};

/** The longest tool result the model sees, in characters, before the wrapping tag. */
const MAX_RESULT_CHARS = 8000;

/** A closing untrusted tag in any case or spacing. */
const CLOSING_TAG = /<\/\s*untrusted[^>]*>/gi;

/** The part of the toolkit's tool definition the bridge reads. */
type ToolkitFunction = { name: string; description?: string; parameters?: Record<string, unknown> };

/** The part of PayPalAgentToolkit the bridge uses, so tests can pass a fake. */
export interface ToolkitLike {
  getTools(): { function: ToolkitFunction }[];
  handleToolCall(call: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }): Promise<{ content: string | { text: string }[] }>;
}

/** The official toolkit, signed in with Behest's PayPal app credentials. */
function toolkitFromEnv(): ToolkitLike {
  const { PAYPAL_CLIENT_ID: clientId, PAYPAL_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
  }
  return new PayPalAgentToolkit({ clientId, clientSecret, configuration: CONFIGURATION });
}

/**
 * The read-only PayPal tools as Claude tools for the tool runner. Uses the toolkit passed in, or builds the
 * official one from the PayPal credentials, so importing this module needs no credentials. A read-only
 * tool the toolkit does not offer is left out with a warning rather than an error.
 */
export function paypalReadOnlyTools(opts: { toolkit?: ToolkitLike } = {}): BetaRunnableTool[] {
  const toolkit = opts.toolkit ?? toolkitFromEnv();
  const offered = toolkit.getTools().map((tool) => tool.function);

  const tools: BetaRunnableTool[] = [];
  const missing: string[] = [];
  for (const name of READ_ONLY_TOOLS) {
    const definition = offered.find((candidate) => candidate.name === name);
    if (definition) tools.push(claudeTool(toolkit, name, definition));
    else missing.push(name);
  }
  if (missing.length > 0) {
    console.warn(`The PayPal Agent Toolkit does not offer ${missing.join(', ')}, so the evidence agent runs without them`);
  }
  return tools;
}

function claudeTool(toolkit: ToolkitLike, name: string, definition: ToolkitFunction): BetaRunnableTool {
  return betaTool({
    name,
    description: definition.description?.trim() || name,
    // Sent to Claude as the toolkit wrote it. The cast only tells betaTool it describes an object.
    inputSchema: (definition.parameters ?? { type: 'object' }) as { type: 'object' },
    run: async (input) => {
      let result;
      try {
        result = await toolkit.handleToolCall({
          id: `call_${randomUUID()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        });
      } catch (error) {
        console.error(`The PayPal Agent Toolkit failed on ${name}: ${describeFailure(error)}`);
        throw new Error(`PayPal could not return ${name}`);
      }
      return asUntrusted(textOf(result.content));
    },
  });
}

/**
 * Why a toolkit call failed, for the server log: the error's stack or message. Never the error object
 * itself, because an HTTP client error carries the request headers, credentials included.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function textOf(content: string | { text: string }[]): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/** `content` inside an untrusted tag it cannot close, cut to MAX_RESULT_CHARS with `...` marking a cut. */
function asUntrusted(content: string): string {
  // Repeated, because removing one tag can join its neighbours into a new one.
  let text = content;
  let previous: string;
  do {
    previous = text;
    text = text.replace(CLOSING_TAG, '');
  } while (text !== previous);

  const capped = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}...` : text;
  return `<untrusted source="paypal">${capped}</untrusted>`;
}
