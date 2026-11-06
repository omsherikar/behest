import { Cart, type CartItem } from '@/lib/domain/cart';
import type { Category } from '@/lib/domain/categories';
import type { MandatePolicy } from '@/lib/domain/policy';
import { PurchaseProposal } from '@/lib/domain/proposal';
import { maxVerdict, type Verdict } from '@/lib/domain/verdict';
import { RULESET_VERSION, type RuleOutcome } from './rules';

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
const block = (detail: string): Check => ({ result: 'block', detail });

const VERDICT_OF: Record<RuleOutcome['result'], Verdict> = { pass: 'ALLOW', skip: 'ALLOW', ask: 'ASK', block: 'BLOCK' };

/**
 * True only when value is at or below limit. A NaN on either side compares false, so a rule
 * written as "fails unless at or below" also fails on a missing or corrupt number.
 */
const atOrBelow = (value: number, limit: number) => value <= limit;

/** Evaluates every rule in order and returns the most severe result with all the reasons. */
export function evaluateGate(input: GateInput): GateResult {
  const { policy } = input;
  const built = buildCart(input);
  const outcomes: RuleOutcome[] = [
    { rule: 'mandate_active', ...mandateActive(input, policy) },
    { rule: 'cart_valid', ...built.check },
  ];
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
      const detail = entry.stock > 0 ? `${entry.title} has only ${entry.stock} in stock` : `${entry.title} is out of stock`;
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
