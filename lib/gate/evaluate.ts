import { Cart, type CartItem } from '@/lib/domain/cart';
import type { Category } from '@/lib/domain/categories';
import { formatUsd } from '@/lib/domain/money';
import type { BudgetPeriod, MandatePolicy } from '@/lib/domain/policy';
import { PurchaseProposal } from '@/lib/domain/proposal';
import { maxVerdict, type Verdict } from '@/lib/domain/verdict';
import {
  MAX_QTY_BEFORE_ASK,
  PRICE_ANOMALY_RATIO,
  RULESET_VERSION,
  type RuleId,
  type RuleOutcome,
} from './rules';

// The policy gate (architecture section 5.1): plain TypeScript with no model in it, deciding
// ALLOW, ASK or BLOCK for one purchase and recording why. Prices, titles and categories come
// only from the catalog the caller re-loaded from the database. The agent's proposal is parsed
// again here and contributes nothing but SKUs and quantities.

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

type Check = Omit<RuleOutcome, 'rule'>;
const pass = (detail: string): Check => ({ result: 'pass', detail });
const ask = (detail: string): Check => ({ result: 'ask', detail });
const block = (detail: string): Check => ({ result: 'block', detail });
const skip = (detail: string): Check => ({ result: 'skip', detail });

const VERDICT_OF: Record<RuleOutcome['result'], Verdict> = { pass: 'ALLOW', skip: 'ALLOW', ask: 'ASK', block: 'BLOCK' };

/**
 * True only when value is at or below limit. A NaN on either side compares false, so a rule
 * written as "fails unless at or below" also fails on a missing or corrupt number.
 */
const atOrBelow = (value: number, limit: number) => value <= limit;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const HOUR_MS = 60 * 60 * 1000;

/** What the rules after cart_valid read. `entries` holds the catalog entry behind each cart item, in order. */
type CartContext = { input: GateInput; policy: MandatePolicy; cart: Cart; entries: CatalogEntry[] };

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
  const { policy } = input;
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

function mandateActive({ mandate, now }: GateInput, policy: MandatePolicy): Check {
  if (mandate.status === 'revoked') return block('This mandate was revoked');
  if (mandate.status !== 'active') return block('This mandate has expired');
  const expiries = [mandate.expiresAt, policy.expiresAt === null ? null : new Date(policy.expiresAt)];
  if (expiries.some((at) => at !== null && at.getTime() <= now.getTime())) return block('This mandate has expired');
  return pass('The mandate is active and has not expired');
}

type BuiltCart = { check: Check; cart: Cart; entries: CatalogEntry[] } | { check: Check; cart: null };

/**
 * The canonical cart: SKUs and quantities from the proposal, everything else from the catalog.
 * `entries` holds the catalog entry behind each cart item, in the same order.
 */
function buildCart({ proposal, seller, catalog }: GateInput): BuiltCart {
  const parsed = PurchaseProposal.safeParse(proposal);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.length > 0 ? ` at ${issue.path.map(String).join('.')}` : '';
    return { check: block(`The proposal is not valid${where}: ${issue.message}`), cart: null };
  }
  if (parsed.data.sellerSlug !== seller.slug) {
    return { check: block(`The proposal names a seller other than ${seller.name}`), cart: null };
  }

  const entries: CatalogEntry[] = [];
  const items: CartItem[] = [];
  for (const { sku, quantity } of parsed.data.items) {
    const entry = catalog.get(sku);
    if (!entry || entry.sku !== sku) return { check: block(`${sku} is not sold by ${seller.name}`), cart: null };
    if (entry.stock !== null && !atOrBelow(quantity, entry.stock)) {
      const detail =
        entry.stock > 0 ? `${entry.title} has only ${entry.stock} in stock` : `${entry.title} is out of stock`;
      return { check: block(detail), cart: null };
    }
    entries.push(entry);
    items.push({ sku, title: entry.title, category: entry.category, unitPriceCents: entry.priceCents, quantity });
  }

  // Every field here comes from the database, so a parse failure means a corrupt catalog entry.
  // It throws rather than blocking quietly, and evaluateGateSafely turns that into a BLOCK.
  const cart = Cart.parse({
    seller: { slug: seller.slug, name: seller.name },
    currency: 'USD',
    items,
    totalCents: items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0),
  });
  return { check: pass(`Every item is listed by ${seller.name} and in stock`), cart, entries };
}

function categoryAllowed({ cart, policy }: CartContext): Check {
  const { allow, deny } = policy.categories;
  const refused = cart.items.find((i) => deny.includes(i.category) || (allow !== null && !allow.includes(i.category)));
  if (refused) return block(`${refused.category.replaceAll('_', ' ')} is not allowed by your mandate`);
  return pass('Every item is in a category your mandate allows');
}

function sellerAllowed({ input: { seller }, policy }: CartContext): Check {
  const { allow, deny } = policy.merchants;
  if (deny.includes(seller.slug) || (allow !== null && !allow.includes(seller.slug))) {
    return block(`${seller.name} is not allowed by your mandate`);
  }
  return pass(`${seller.name} is allowed by your mandate`);
}

function listingClean({ entries }: CartContext): Check {
  const flagged = entries.find((e) => e.flags.length > 0);
  if (!flagged) return pass('No item in the cart was flagged by listing screening');
  return block(
    flagged.flags.includes('agent_instructions')
      ? `${flagged.title} contains instructions aimed at AI agents`
      : `${flagged.title} was flagged by listing screening`,
  );
}

function perPurchaseMax({ cart, policy }: CartContext): Check {
  const total = formatUsd(cart.totalCents);
  const limit = `${formatUsd(policy.perPurchaseMaxCents)} per-purchase limit`;
  return atOrBelow(cart.totalCents, policy.perPurchaseMaxCents)
    ? pass(`${total} is within your ${limit}`)
    : block(`${total} is over your ${limit}`);
}

const LEFT_IN_PERIOD: Record<BudgetPeriod, string> = {
  day: 'left this day',
  week: 'left this week',
  month: 'left this month',
  once: 'left on this mandate',
};

function budgetRemaining({ cart, policy, input }: CartContext): Check {
  const remaining = Math.max(0, policy.budget.amountCents - input.spentInPeriodCents);
  const total = formatUsd(cart.totalCents);
  const left = `${formatUsd(remaining)} ${LEFT_IN_PERIOD[policy.budget.period]}`;
  return atOrBelow(cart.totalCents, remaining)
    ? pass(`${total} fits in the ${left}`)
    : block(`${total} would exceed the ${left}`);
}

function velocity({ policy, input }: CartContext): Check {
  if (policy.velocity === null) return pass('Your mandate sets no limit on how often to buy');
  const { maxPurchases, windowHours } = policy.velocity;
  const windowStart = input.now.getTime() - windowHours * HOUR_MS;
  const recent = input.recentPurchaseTimes.filter((t) => t.getTime() > windowStart).length;
  const limit = `limit of ${plural(maxPurchases, 'purchase')} in ${plural(windowHours, 'hour')}`;
  return recent < maxPurchases ? pass(`Within your ${limit}`) : block(`Your ${limit} is already reached`);
}

function askThreshold({ cart, policy }: CartContext): Check {
  if (policy.askAboveCents === null) return pass('Your mandate sets no approval limit on amount');
  const total = formatUsd(cart.totalCents);
  const limit = `${formatUsd(policy.askAboveCents)} approval limit`;
  return atOrBelow(cart.totalCents, policy.askAboveCents)
    ? pass(`${total} is within your ${limit}`)
    : ask(`${total} is over your ${limit}`);
}

function priceBenchmark({ entries }: CartContext): Check {
  let benchmarked = false;
  // The entries' prices are the cart's prices, since the cart was built from them.
  for (const { title, priceCents, marketMedianCents } of entries) {
    if (marketMedianCents === null) continue;
    benchmarked = true;
    if (!atOrBelow(priceCents, PRICE_ANOMALY_RATIO * marketMedianCents)) {
      const price = formatUsd(priceCents);
      const median = formatUsd(marketMedianCents);
      return ask(`${title} costs ${price}, more than ${PRICE_ANOMALY_RATIO} times its ${median} market median`);
    }
  }
  return benchmarked
    ? pass(`Every benchmarked price is within ${PRICE_ANOMALY_RATIO} times its market median`)
    : skip('No market price benchmark exists for these items');
}

function quantity({ cart }: CartContext): Check {
  const bulk = cart.items.find((i) => !atOrBelow(i.quantity, MAX_QTY_BEFORE_ASK));
  return bulk
    ? ask(`${bulk.title} has a quantity of ${bulk.quantity}, more than ${MAX_QTY_BEFORE_ASK}`)
    : pass(`No item has a quantity over ${MAX_QTY_BEFORE_ASK}`);
}

function walletLinked({ walletLinked }: GateInput): Check {
  // Compared strictly, so a missing value asks the buyer instead of passing.
  return walletLinked === true ? pass('A saved PayPal wallet is linked') : ask('No saved PayPal wallet is linked');
}
