// The bridge between PayPal's official Agent Toolkit and Claude. The evidence agent may only read
// disputes, orders and shipment tracking, so only the tools named in READ_ONLY_TOOLS ever become Claude
// tools, whatever the toolkit offers. That list, not the toolkit configuration, is the guard: the
// toolkit's handleToolCall runs any tool it knows by name without checking its configuration.
// Everything a tool returns is third-party data, and a dispute can hold text written to steer the agent,
// so each result goes to the model through wrapUntrusted, in a tag the content cannot close, capped in length.

import { randomUUID } from 'node:crypto';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import { wrapUntrusted } from '../llm/untrusted';

/** The only PayPal tools the evidence agent is given. Each one only reads from PayPal. */
export const READ_ONLY_TOOLS = ['list_disputes', 'get_dispute', 'get_order', 'get_shipment_tracking'] as const;

/** The toolkit actions behind READ_ONLY_TOOLS, so the toolkit builds no other tools to begin with. */
const CONFIGURATION = {
  actions: { disputes: { list: true, get: true }, orders: { get: true }, shipment: { get: true } },
  context: { sandbox: true },
};

/** The longest tool result the model sees, in characters, inside the untrusted tag. */
const MAX_RESULT_CHARS = 8000;

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

/**
 * The official toolkit, signed in with Behest's PayPal app credentials and given only the read actions.
 * Not exported: its handleToolCall runs any of the toolkit's tools by name, so nothing outside this
 * module gets it, only the read-only tools paypalReadOnlyTools builds from it.
 */
function paypalAgentToolkit(): PayPalAgentToolkit {
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
 *
 * Build the tools once per agent run and let them go with it: the official toolkit fetches one OAuth token
 * on first use and keeps it without ever refreshing, so tools kept longer than the token lives would fail.
 */
export function paypalReadOnlyTools(opts: { toolkit?: ToolkitLike } = {}): BetaRunnableTool[] {
  const toolkit = opts.toolkit ?? paypalAgentToolkit();
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
    // Given as the toolkit wrote it. The cast only tells betaTool it describes an object. The tool
    // loop sends it in the form strict mode accepts, with keywords such as pattern, minimum and
    // default moved into descriptions, so invalidArgument below still enforces the patterns.
    inputSchema: (definition.parameters ?? { type: 'object' }) as { type: 'object' },
    strict: true,
    run: async (input) => {
      const invalid = invalidArgument(definition.parameters, input);
      if (invalid) {
        console.warn(`Refused a ${name} call whose ${invalid} does not match the PayPal Agent Toolkit schema`);
        throw new Error(`${name} was given an invalid ${invalid}`);
      }

      let content: string;
      try {
        const result = await toolkit.handleToolCall({
          id: `call_${randomUUID()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        });
        content = textOf(result.content);
      } catch (error) {
        failed(name, describeFailure(error));
      }
      const reported = reportedFailure(content);
      if (reported) failed(name, reported);
      return wrapUntrusted('paypal', content, MAX_RESULT_CHARS);
    },
  });
}

/**
 * The first argument that breaks the toolkit's own schema by not being a string where the schema asks for
 * one, or by missing the schema's pattern. The toolkit checks no arguments. It puts dispute_id, id and
 * order_id into request paths, where `..` segments are resolved, so `../../v1/reporting/transactions` would
 * send an authenticated GET to another PayPal endpoint, and it puts transaction_id into a query string
 * unescaped. A value that is not a string is refused too, because an array would be joined into the path.
 */
function invalidArgument(schema: Record<string, unknown> | undefined, input: Record<string, unknown>): string | undefined {
  const properties = (schema?.properties ?? {}) as Record<string, { type?: unknown; pattern?: unknown }>;
  return Object.keys(properties).find((key) => {
    const { type, pattern } = properties[key];
    if (type !== 'string' || !Object.hasOwn(input, key)) return false;
    const value = input[key];
    return typeof value !== 'string' || (typeof pattern === 'string' && !new RegExp(pattern).test(value));
  });
}

/** Logs why `name` failed and throws the short message the model sees, which never carries the cause. */
function failed(name: string, cause: string): never {
  console.error(`The PayPal Agent Toolkit failed on ${name}: ${cause}`);
  throw new Error(`PayPal could not return ${name}`);
}

/**
 * The failure a toolkit result reports, described for the log, or null for a real result. The toolkit
 * catches its own errors and returns them as content rather than throwing: an LlmError as
 * `{ ok: false, status, code, message }` with a message it keeps free of secrets, and any other error as
 * `{ error: { message, type: 'paypal_error' } }`.
 */
function reportedFailure(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.ok === false) {
    return `${String(parsed.code)}, status ${String(parsed.status ?? 'unknown')}: ${String(parsed.message)}`;
  }
  const { error } = parsed;
  if (isRecord(error) && error.type === 'paypal_error') return `paypal_error: ${String(error.message)}`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
