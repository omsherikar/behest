import { categoryLabel, type Category } from '@/lib/domain/categories';
import { formatUsd } from '@/lib/domain/money';
import { MandatePolicy, type BudgetPeriod } from '@/lib/domain/policy';
import type { Verdict } from '@/lib/domain/verdict';
import { plural } from '@/lib/domain/words';
import { evaluateGateSafely, type GateInput } from '@/lib/gate/evaluate';
import type { RuleId, RuleOutcome } from '@/lib/gate/rules';

// What would have let a held or blocked purchase through: the smallest change to the buyer's
// mandate, found by running the deterministic gate again on adjusted copies of the policy. Pure:
// it takes the gate's input for the purchase as it was decided, and reads nothing else.
//
// Some purchases no mandate can allow, and for those it says why instead of suggesting anything: a
// mandate that has expired or was revoked, a listing flagged for instructions aimed at AI agents
// (or flagged at all), a cart that is not real, and a cart the intent check found does not match
// the request. A purchase the intent check sent to the buyer can only be approved by the buyer.

export type ChangeKind =
  | 'link_wallet'
  | 'raise_per_purchase_max'
  | 'raise_budget'
  | 'raise_ask_threshold'
  | 'raise_velocity'
  | 'allow_category'
  | 'allow_seller'
  | 'remove_ask_threshold'
  | 'remove_velocity';

export type MandateChange = {
  kind: ChangeKind;
  /** The change in the buyer's words, such as "Raise your per-purchase limit to $40.00". */
  text: string;
  /** What the gate decides with the change: allowed, or still sent to the buyer to approve. */
  outcome: 'ALLOW' | 'ASK';
  /** The mandate's policy with the change made, or with every change made when they go together. */
  policy: MandatePolicy;
  /** Whether the wallet is linked once the change is made. */
  walletLinked: boolean;
};

export type WhatWouldChange =
  /** The gate allows it already: nothing to change. */
  | { kind: 'allowed' }
  /**
   * `approve`: the purchase waits for the buyer, who can approve this one at PayPal. `changes`: the
   * mandate changes that would have let it through, smallest first. With `together` false each one
   * works alone; with it true, only all of them together do. `changes` is empty when no mandate
   * change helps and the buyer can only approve it.
   */
  | { kind: 'changes'; approve: boolean; changes: MandateChange[]; together: boolean }
  /** No change to the mandate can allow it; `reason` says why, as a sentence. */
  | { kind: 'cannot'; reason: string };

/** The intent check's verdict on the purchase, or null when it did not run. */
export type IntentVerdict = 'consistent' | 'needs_human' | 'inconsistent' | 'unavailable' | null;

/** The rules whose failure no mandate can fix: they are about the mandate's life, the listing or the cart itself. */
const BEYOND_THE_MANDATE: ReadonlySet<RuleId> = new Set(['mandate_active', 'cart_valid', 'listing_clean', 'internal_error']);

const INTENT_MISMATCH = 'The intent check found that this cart does not match what you asked for.';

const BUDGET_WORD: Record<BudgetPeriod, string> = { day: 'daily', week: 'weekly', month: 'monthly', once: 'total' };

const HOUR_MS = 60 * 60 * 1000;

/** A gate detail as a sentence ending in a full stop. */
const sentence = (detail: string) => (/[.!?]$/.test(detail) ? detail : `${detail}.`);

/** One way to fix a failing rule: a new gate input, and how big a change it is for ordering. */
type Candidate = { kind: ChangeKind; text: string; input: GateInput; tier: number; size: number };

const withPolicy = (input: GateInput, policy: MandatePolicy): GateInput => ({ ...input, policy });

/**
 * The single changes that address one failing rule, smallest first. `cart` is the canonical cart
 * the gate built, so totals and categories are the catalog's, never the agent's.
 */
function candidatesFor(rule: RuleId, input: GateInput, totalCents: number, categories: Category[]): Candidate[] {
  const { policy } = input;
  switch (rule) {
    case 'wallet_linked':
      return [{ kind: 'link_wallet', text: 'Link your PayPal wallet', input: { ...input, walletLinked: true }, tier: 1, size: 0 }];
    case 'per_purchase_max':
      return [
        {
          kind: 'raise_per_purchase_max',
          text: `Raise your per-purchase limit to ${formatUsd(totalCents)}`,
          input: withPolicy(input, { ...policy, perPurchaseMaxCents: totalCents }),
          tier: 2,
          size: totalCents - policy.perPurchaseMaxCents,
        },
      ];
    case 'budget_remaining': {
      const amount = input.spentInPeriodCents + totalCents;
      const by = amount - policy.budget.amountCents;
      return [
        {
          kind: 'raise_budget',
          text: `Raise your ${BUDGET_WORD[policy.budget.period]} budget by ${formatUsd(by)}, to ${formatUsd(amount)}`,
          input: withPolicy(input, { ...policy, budget: { ...policy.budget, amountCents: amount } }),
          tier: 2,
          size: by,
        },
      ];
    }
    case 'ask_threshold':
      return [
        {
          kind: 'raise_ask_threshold',
          text: `Raise your approval limit to ${formatUsd(totalCents)}`,
          input: withPolicy(input, { ...policy, askAboveCents: totalCents }),
          tier: 2,
          size: totalCents - (policy.askAboveCents ?? 0),
        },
        {
          kind: 'remove_ask_threshold',
          text: 'Stop asking you about purchases on their amount alone',
          input: withPolicy(input, { ...policy, askAboveCents: null }),
          tier: 4,
          size: 0,
        },
      ];
    case 'velocity': {
      if (policy.velocity === null) return [];
      const { maxPurchases, windowHours } = policy.velocity;
      const windowStart = input.now.getTime() - windowHours * HOUR_MS;
      const recent = input.recentPurchaseTimes.filter((at) => at.getTime() > windowStart).length;
      return [
        {
          kind: 'raise_velocity',
          text: `Allow ${plural(recent + 1, 'purchase')} in ${plural(windowHours, 'hour')}`,
          input: withPolicy(input, { ...policy, velocity: { maxPurchases: recent + 1, windowHours } }),
          tier: 3,
          size: recent + 1 - maxPurchases,
        },
        {
          kind: 'remove_velocity',
          text: 'Remove the limit on how often your agent buys',
          input: withPolicy(input, { ...policy, velocity: null }),
          tier: 4,
          size: 0,
        },
      ];
    }
    case 'category_allowed': {
      const { allow, deny } = policy.categories;
      const refused = [...new Set(categories)].filter((c) => deny.includes(c) || (allow !== null && !allow.includes(c)));
      if (refused.length === 0) return [];
      const labels = refused.map(categoryLabel);
      return [
        {
          kind: 'allow_category',
          text: refused.length === 1 ? `Allow the category ${labels[0]}` : `Allow the categories ${labels.join(' and ')}`,
          input: withPolicy(input, {
            ...policy,
            categories: {
              allow: allow === null ? null : [...allow, ...refused.filter((c) => !allow.includes(c))],
              deny: deny.filter((c) => !refused.includes(c)),
            },
          }),
          tier: 3,
          size: refused.length,
        },
      ];
    }
    case 'seller_allowed': {
      const { allow, deny } = policy.merchants;
      const { slug, name } = input.seller;
      if (deny.includes(slug)) {
        return [
          {
            kind: 'allow_seller',
            text: `Remove ${name} from your blocked sellers`,
            input: withPolicy(input, {
              ...policy,
              merchants: { allow: allow && !allow.includes(slug) ? [...allow, slug] : allow, deny: deny.filter((s) => s !== slug) },
            }),
            tier: 3,
            size: 1,
          },
        ];
      }
      if (allow !== null && !allow.includes(slug)) {
        return [
          {
            kind: 'allow_seller',
            text: `Add ${name} to your allowed sellers`,
            input: withPolicy(input, { ...policy, merchants: { allow: [...allow, slug], deny } }),
            tier: 3,
            size: 1,
          },
        ];
      }
      return [];
    }
    // The price benchmark and the quantity rule have no setting in the mandate: only the buyer's
    // approval lets such a purchase through.
    default:
      return [];
  }
}

/** The gate's verdict on `input`, or null when the adjusted policy is not one a buyer could confirm. */
function verdictWith(input: GateInput): Verdict | null {
  if (!MandatePolicy.safeParse(input.policy).success) return null;
  return evaluateGateSafely(input).verdict;
}

/** A candidate as a change; `made` is the input with it made, or with every change made for a set. */
const toChange = (candidate: Candidate, outcome: 'ALLOW' | 'ASK', made: GateInput = candidate.input): MandateChange => ({
  kind: candidate.kind,
  text: candidate.text,
  outcome,
  policy: made.policy,
  walletLinked: made.walletLinked,
});

const bySize = (a: Candidate, b: Candidate) => a.tier - b.tier || a.size - b.size;

/**
 * The changes for every failing rule made together: the first candidate of each, and for the
 * approval limit the first that leaves a valid policy, made last, since a raised per-purchase limit
 * decides whether raising the approval limit is still allowed.
 */
function together(failing: RuleOutcome[], input: GateInput, totalCents: number, categories: Category[]): { input: GateInput; picked: Candidate[] } {
  let current = input;
  const picked: Candidate[] = [];
  const asks = failing.filter((o) => o.rule === 'ask_threshold');
  for (const outcome of [...failing.filter((o) => o.rule !== 'ask_threshold'), ...asks]) {
    const options = candidatesFor(outcome.rule, current, totalCents, categories);
    const option =
      outcome.rule === 'ask_threshold'
        ? options.find((o) => MandatePolicy.safeParse(o.input.policy).success)
        : options[0];
    if (!option) continue;
    current = option.input;
    picked.push(option);
  }
  return { input: current, picked };
}

/**
 * What would let the purchase decided on `input` through. `intent` is the intent check's verdict, or
 * null when it did not run (the gate blocked). See WhatWouldChange for the answers.
 */
export function whatWouldChange(input: GateInput, intent: IntentVerdict = null): WhatWouldChange {
  const gate = evaluateGateSafely(input);
  const stuck = gate.outcomes.find((o) => o.result === 'block' && BEYOND_THE_MANDATE.has(o.rule));
  if (stuck) return { kind: 'cannot', reason: sentence(stuck.detail) };
  if (intent === 'inconsistent') return { kind: 'cannot', reason: INTENT_MISMATCH };

  // The intent check asked the buyer. It reads the request and the cart, not the mandate, so no
  // mandate change would have stopped it asking.
  const intentAsked = intent === 'needs_human' || intent === 'unavailable';
  if (gate.verdict === 'ALLOW') return intentAsked ? { kind: 'changes', approve: true, changes: [], together: false } : { kind: 'allowed' };
  const approve = gate.verdict === 'ASK';
  if (intentAsked || !gate.cart) return { kind: 'changes', approve, changes: [], together: false };

  const { totalCents } = gate.cart;
  const categories = gate.cart.items.map((item) => item.category);
  const failing = gate.outcomes.filter((o) => o.result === 'block' || o.result === 'ask');
  const candidates = failing.flatMap((o) => candidatesFor(o.rule, input, totalCents, categories)).sort(bySize);

  const allowing = candidates.filter((c) => verdictWith(c.input) === 'ALLOW');
  if (allowing.length > 0) return { kind: 'changes', approve, changes: allowing.map((c) => toChange(c, 'ALLOW')), together: false };

  const all = together(failing, input, totalCents, categories);
  const allVerdict = all.picked.length > 1 ? verdictWith(all.input) : null;
  if (allVerdict === 'ALLOW') return { kind: 'changes', approve, changes: all.picked.map((c) => toChange(c, 'ALLOW', all.input)), together: true };

  // Nothing allows it outright. A blocked purchase may still be one the buyer could then approve.
  if (gate.verdict === 'BLOCK') {
    const asking = candidates.filter((c) => verdictWith(c.input) === 'ASK');
    if (asking.length > 0) return { kind: 'changes', approve: false, changes: asking.map((c) => toChange(c, 'ASK')), together: false };
    if (allVerdict === 'ASK') return { kind: 'changes', approve: false, changes: all.picked.map((c) => toChange(c, 'ASK', all.input)), together: true };
    const blocks = failing.filter((o) => o.result === 'block').map((o) => sentence(o.detail));
    return { kind: 'cannot', reason: blocks.join(' ') };
  }
  return { kind: 'changes', approve, changes: [], together: false };
}
