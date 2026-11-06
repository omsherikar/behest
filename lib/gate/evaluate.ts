import type { Cart } from '@/lib/domain/cart';
import type { Category } from '@/lib/domain/categories';
import { MandatePolicy } from '@/lib/domain/policy';
import type { PurchaseProposal } from '@/lib/domain/proposal';
import { maxVerdict, type Verdict } from '@/lib/domain/verdict';
import { RULESET_VERSION, type RuleId, type RuleOutcome } from '@/lib/gate/rules';
import { buildCart } from '@/lib/gate/rules/cart';
import { skip, type CartContext, type Check } from '@/lib/gate/rules/check';
import { askThreshold, priceBenchmark, quantity, walletLinked } from '@/lib/gate/rules/escalations';
import { budgetRemaining, perPurchaseMax, velocity } from '@/lib/gate/rules/limits';
import { mandateActive } from '@/lib/gate/rules/mandate';
import { categoryAllowed, listingClean, sellerAllowed } from '@/lib/gate/rules/scope';

// The policy gate (architecture section 5.1): plain TypeScript with no model in it, deciding
// ALLOW, ASK or BLOCK for one purchase and recording why. Prices, titles and categories come
// only from the catalog the caller re-loaded from the database. The agent's proposal is parsed
// again here and contributes nothing but SKUs and quantities. The rules themselves live in
// lib/gate/rules/, one file per group.

/** One of the seller's listings as stored by Behest. */
export type CatalogEntry = {
  sku: string;
  title: string;
  category: Category;
  priceCents: number;
  /** Units on hand. Null means the seller does not track stock. */
  stock: number | null;
  /** Listing screening results, such as `agent_instructions`. Any flag blocks the purchase. */
  flags: string[];
  /** Market median unit price from Channel3, when a benchmark exists. */
  marketMedianCents: number | null;
};

export type GateInput = {
  policy: MandatePolicy;
  mandate: { status: 'active' | 'revoked' | 'expired'; expiresAt: Date | null };
  walletLinked: boolean;
  seller: { slug: string; name: string };
  /** Written by the agent, so untrusted: the gate parses it again before reading it. */
  proposal: PurchaseProposal;
  /** The seller's listings by SKU, loaded from the database. */
  catalog: Map<string, CatalogEntry>;
  /** Spend in the current budget period, counting purchases still in flight. */
  spentInPeriodCents: number;
  /** When the mandate's recent purchases were made, counting purchases still in flight. */
  recentPurchaseTimes: Date[];
  now: Date;
};

export type GateResult = {
  verdict: Verdict;
  outcomes: RuleOutcome[];
  /** The canonical cart built from the catalog, or null when the proposal could not become one. */
  cart: Cart | null;
  rulesetVersion: typeof RULESET_VERSION;
};

const VERDICT_OF: Record<RuleOutcome['result'], Verdict> = { pass: 'ALLOW', skip: 'ALLOW', ask: 'ASK', block: 'BLOCK' };

/** The rules that need a valid cart, in order. When there is no cart they are all skipped. */
const CART_RULES: [RuleId, (context: CartContext) => Check][] = [
  ['category_allowed', categoryAllowed],
  ['seller_allowed', sellerAllowed],
  ['listing_clean', listingClean],
  ['per_purchase_max', perPurchaseMax],
  ['budget_remaining', budgetRemaining],
  ['velocity', velocity],
  ['ask_threshold', askThreshold],
  ['price_benchmark', priceBenchmark],
  ['quantity', quantity],
];

const NOT_CHECKED = skip('Not checked because the cart is not valid');

/** Evaluates every rule in order and returns the most severe result with all the reasons. */
export function evaluateGate(input: GateInput): GateResult {
  assertValidInputs(input);
  // Parsed again despite its type: a policy missing its expiry, for one, would never expire.
  const policy = MandatePolicy.parse(input.policy);
  const built = buildCart(input);
  const outcomes: RuleOutcome[] = [
    { rule: 'mandate_active', ...mandateActive(input, policy) },
    { rule: 'cart_valid', ...built.check },
  ];
  const context: CartContext | null = built.cart && { input, policy, cart: built.cart, entries: built.entries };
  for (const [rule, check] of CART_RULES) outcomes.push({ rule, ...(context ? check(context) : NOT_CHECKED) });
  outcomes.push({ rule: 'wallet_linked', ...walletLinked(input) });
  return {
    verdict: maxVerdict(...outcomes.map((o) => VERDICT_OF[o.result])),
    outcomes,
    cart: built.cart,
    rulesetVersion: RULESET_VERSION,
  };
}

const isValidDate = (value: unknown) => value instanceof Date && !Number.isNaN(value.getTime());

/**
 * Throws on the spend and dates whose bad values would otherwise slip past a rule: a negative
 * spend adds to the budget, and an invalid date compares false. The throw blocks the purchase.
 */
function assertValidInputs({ mandate, spentInPeriodCents, recentPurchaseTimes, now }: GateInput): void {
  const dates = [now, ...recentPurchaseTimes, ...(mandate.expiresAt === null ? [] : [mandate.expiresAt])];
  if (!dates.every(isValidDate)) throw new Error('the gate was given an invalid date');
  if (!Number.isSafeInteger(spentInPeriodCents) || spentInPeriodCents < 0) {
    throw new Error('the gate was given an invalid period spend');
  }
}

const FAILED_CLOSED: RuleOutcome = {
  rule: 'internal_error',
  result: 'block',
  detail: 'The policy check failed, so nothing was bought.',
};

/** The gate as callers should run it: any exception becomes a BLOCK, so an error can never pay. */
export function evaluateGateSafely(input: GateInput): GateResult {
  try {
    return evaluateGate(input);
  } catch (error) {
    console.error('Policy gate failed, so the purchase was blocked:', error);
    return { verdict: 'BLOCK', outcomes: [{ ...FAILED_CLOSED }], cart: null, rulesetVersion: RULESET_VERSION };
  }
}
