import type { StoredIntentResult, StoredRuleOutcome } from '@/lib/db/schema';

// How a purchase was decided, step by step, for the decision ledger: every gate rule's outcome in
// rule order, then the intent check's reasons when it held the purchase back. An intent check
// that wanted the buyer to look reads as an ask; one that found the cart inconsistent, as a block.

/** The rule id the intent check's reasons appear under. */
export const INTENT_RULE = 'intent_check';

const RESULT = { needs_human: 'ask', inconsistent: 'block' } as const;

const NO_REASON = {
  needs_human: 'The intent check could not confirm that the cart matches the request.',
  inconsistent: 'The intent check found that the cart does not match the request.',
} as const;

export function decisionOutcomes(purchase: {
  gateOutcomes: StoredRuleOutcome[];
  intent: StoredIntentResult | null;
}): StoredRuleOutcome[] {
  const { gateOutcomes, intent } = purchase;
  const verdict = intent?.verdict;
  if (!intent || (verdict !== 'needs_human' && verdict !== 'inconsistent')) return gateOutcomes;
  const reasons = intent.reasons.length > 0 ? intent.reasons : [NO_REASON[verdict]];
  return [...gateOutcomes, ...reasons.map((detail) => ({ rule: INTENT_RULE, result: RESULT[verdict], detail }))];
}
