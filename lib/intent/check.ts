import { z } from 'zod';
import type { LlmDeps } from '@/lib/llm/client';
import { callStructured } from '@/lib/llm/structured';
import { wrapUntrusted } from '@/lib/llm/untrusted';
import { INTENT_SYSTEM_PROMPT } from './prompts';
import type { IntentInput, IntentResult } from './types';

// Asks the model whether a cart is what the buyer asked for. The buyer's request, mandate and
// readback go to the model as written. The cart's item titles were written by sellers and the
// rationale by the agent, so both go inside untrusted wrappers that they cannot close.

/**
 * The reply as the model writes it. The limits on reasons are not in the schema, so a reason that
 * runs long is cut here instead of failing the whole check.
 */
const IntentOutput = z.object({
  verdict: z.enum(['consistent', 'needs_human', 'inconsistent']),
  reasons: z.array(z.string()),
});

const MAX_REASONS = 5;
const MAX_REASON_CHARS = 200;
/** How much of the cart's JSON and of the rationale the model reads. The prompt says what a cut means. */
const MAX_CART_CHARS = 20_000;
const MAX_RATIONALE_CHARS = 4_000;

/** `text` cut to `max` characters, counted in code points, with `...` marking the cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`;
}

function userMessage(input: IntentInput): string {
  return [
    `<request>\n${input.request}\n</request>`,
    `<mandate>\n${input.mandateText}\n</mandate>`,
    `<readback>\n${input.readback.join('\n')}\n</readback>`,
    `<cart>\n${wrapUntrusted('seller_listing', JSON.stringify(input.cart), MAX_CART_CHARS)}\n</cart>`,
    `<agent_rationale>\n${wrapUntrusted('agent', input.agentRationale, MAX_RATIONALE_CHARS)}\n</agent_rationale>`,
  ].join('\n\n');
}

/**
 * Checks a cart against the buyer's request and mandate, with at most five reasons of at most 200
 * characters. A model call that fails in any way, including a refusal or a spent daily budget,
 * returns `unavailable` with the failure's name as the reason; only misconfiguration and database
 * errors throw.
 */
export async function checkIntent(deps: LlmDeps, input: IntentInput): Promise<IntentResult> {
  const reply = await callStructured(deps, 'intent_check', {
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(input) }],
    schema: IntentOutput,
  });
  if (!reply.ok) return { verdict: 'unavailable', reasons: [reply.error] };

  const { verdict, reasons } = reply.value;
  return { verdict, reasons: reasons.slice(0, MAX_REASONS).map((reason) => clip(reason, MAX_REASON_CHARS)) };
}
