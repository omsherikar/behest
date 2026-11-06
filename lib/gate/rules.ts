// Identifiers and thresholds of the policy gate. The version string goes into every receipt,
// so change it whenever a rule, a threshold or the rule order changes: a recorded decision can
// then be replayed against the exact rules that made it.

export const RULESET_VERSION = 'gate-v1';

/** A single SKU ordered in a larger quantity than this goes to the buyer. */
export const MAX_QTY_BEFORE_ASK = 5;

/** A unit price above this multiple of its market median goes to the buyer. */
export const PRICE_ANOMALY_RATIO = 1.5;

/** The gate's rules in evaluation order. Every decision records one outcome for each. */
export const GATE_RULES = [
  'mandate_active',
  'cart_valid',
  'category_allowed',
  'seller_allowed',
  'listing_clean',
  'per_purchase_max',
  'budget_remaining',
  'velocity',
  'ask_threshold',
  'price_benchmark',
  'quantity',
  'wallet_linked',
] as const;

/** A gate rule, or `internal_error` when the gate itself failed and the purchase was blocked. */
export type RuleId = (typeof GATE_RULES)[number] | 'internal_error';

export type RuleOutcome = {
  rule: RuleId;
  /** `skip` means the rule could not be checked, for example because the cart was not valid. */
  result: 'pass' | 'ask' | 'block' | 'skip';
  /** One short plain sentence for the buyer saying why. */
  detail: string;
};
