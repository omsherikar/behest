import type { StoredIntentResult, StoredRuleOutcome } from '@/lib/db/schema';

/**
 * Why a purchase was not simply allowed, as the purchase flow reports it to the agent (see
 * purchaseOutcome): the detail of each gate rule that did not pass, in rule order, then the intent
 * check's reasons. A detail may quote what a seller wrote, so the pages show each one as text.
 */
export function purchaseReasons(purchase: { gateOutcomes: StoredRuleOutcome[]; intent: StoredIntentResult | null }): string[] {
  const failedRules = purchase.gateOutcomes.filter((o) => o.result !== 'pass' && o.result !== 'skip').map((o) => o.detail);
  return [...failedRules, ...(purchase.intent?.reasons ?? [])];
}
