import { z } from 'zod';
import type { Cart } from '@/lib/domain/cart';
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
export const IntentOutput = z.object({
  verdict: z.enum(['consistent', 'needs_human', 'inconsistent']),
  reasons: z.array(z.string()),
});

const MAX_REASONS = 5;
const MAX_REASON_CHARS = 200;
/** The reason shown for a verdict that flags the purchase when the model gives none. */
const NO_REASON = 'The intent check flagged this purchase without giving a reason.';
/** The reason shown first when the model was shown only part of the cart. */
const CART_CUT = 'The cart was too long to check in full.';
/**
 * How much of the cart's JSON and of the rationale the model reads. Seller-written titles have no
 * length limit and come before each quantity, so a long title can push quantities and later items
 * out of view; a cart cut to fit is therefore never found consistent.
 */
const MAX_CART_CHARS = 20_000;
const MAX_RATIONALE_CHARS = 4_000;

/** `text` cut to `max` characters, counted in code points, with `...` marking the cut. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`;
}

/** The cart as the model reads it, and whether it was cut to fit. */
function cartForModel(cart: Cart): { text: string; cut: boolean } {
  const json = JSON.stringify(cart);
  const text = wrapUntrusted('seller_listing', json, MAX_CART_CHARS);
  // Compared with the uncut wrapping, so the length is counted as the wrapper counts it, after escaping.
  return { text, cut: text !== wrapUntrusted('seller_listing', json, Infinity) };
}

function userMessage(input: IntentInput, cartText: string): string {
  return [
    `<request>\n${input.request}\n</request>`,
    `<mandate>\n${input.mandateText}\n</mandate>`,
    `<readback>\n${input.readback.join('\n')}\n</readback>`,
    `<cart>\n${cartText}\n</cart>`,
    `<agent_rationale>\n${wrapUntrusted('agent', input.agentRationale, MAX_RATIONALE_CHARS)}\n</agent_rationale>`,
  ].join('\n\n');
}

/** At most five reasons of at most 200 characters each. */
function kept(reasons: string[]): string[] {
  return reasons.slice(0, MAX_REASONS).map((reason) => clip(reason, MAX_REASON_CHARS));
}

/**
 * Checks a cart against the buyer's request and mandate, with at most five reasons of at most 200
 * characters. A verdict that flags the purchase always has a reason. A cart too long to show the
 * model in full gets at least needs_human, with that reason first. A model call that fails in any
 * way, including a refusal or a spent daily budget, returns `unavailable` with the failure's name as
 * the reason; only misconfiguration and database errors throw.
 */
export async function checkIntent(deps: LlmDeps, input: IntentInput): Promise<IntentResult> {
  const cart = cartForModel(input.cart);
  const reply = await callStructured(deps, 'intent_check', {
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(input, cart.text) }],
    schema: IntentOutput,
  });
  if (!reply.ok) return { verdict: 'unavailable', reasons: [reply.error] };

  const { verdict, reasons: given } = reply.value;
  const reasons = verdict !== 'consistent' && given.length === 0 ? [NO_REASON] : given;
  if (!cart.cut) return { verdict, reasons: kept(reasons) };
  // The model judged only the part of the cart it was shown. Its reasons for finding the cart
  // consistent describe that part alone, so they are not shown as if they covered the whole cart.
  if (verdict === 'consistent') return { verdict: 'needs_human', reasons: [CART_CUT] };
  return { verdict, reasons: kept([CART_CUT, ...reasons]) };
}
