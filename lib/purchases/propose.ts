import { and, desc, eq, gt, gte, inArray, isNotNull, sum } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { mandates, products, purchases, sellers, wallets } from '@/lib/db/schema';
import { MandatePolicy } from '@/lib/domain/policy';
import { PurchaseProposal } from '@/lib/domain/proposal';
import type { Verdict } from '@/lib/domain/verdict';
import { evaluateGateSafely, type CatalogEntry, type GateInput } from '@/lib/gate/evaluate';
import { periodStart } from '@/lib/gate/period';
import { quoteAgentText } from '@/lib/gate/rules/check';
import { applyIntent } from '@/lib/intent/apply';
import { hashOf } from '@/lib/receipts/canonical';
import { startApproval } from './approval';
import { chargeAllowed, purchaseOutcome } from './charge';
import type { IntentInput, IntentResult, ProposalOutcome, PurchaseDeps } from './deps';
import { appendEvent, transition } from './events';
import { COUNTS_AGAINST_BUDGET } from './transitions';

// Turning a shopping agent's proposal into a decision and acting on it (architecture sections 5.1,
// 5.2 and 6.2 to 6.4). The gate decides inside one transaction that holds the buyer's mandate row,
// and the purchase is inserted before that transaction commits, so its total is reserved against the
// budget at once and two proposals can never both fit into the same remaining budget. The intent
// check then runs with no lock held and can only tighten the gate's verdict. The final verdict is
// routed: BLOCK ends the purchase, ALLOW charges the saved wallet, ASK sends the buyer to PayPal.

/** A purchase the shopping agent proposes for a buyer. */
export type ProposalRequest = {
  buyerId: string;
  /** The shopping agent run that proposed it, if any. */
  runId: string | null;
  /** What the buyer asked the agent to buy, in their own words. */
  request: string;
  /** Written by the agent, so untrusted: the gate reads only its seller, SKUs and quantities. */
  proposal: PurchaseProposal;
};

/** A reserved purchase: its id, the gate's verdict, and what the intent check reads, or null when the gate blocked it. */
type Reserved = { purchaseId: string; gateVerdict: Verdict; check: IntentInput | null };

const HOUR_MS = 60 * 60 * 1000;

/** The reason recorded when the intent check throws instead of answering. */
const CHECK_FAILED = 'internal_error';

const MANDATE_FIELDS = {
  id: mandates.id,
  sourceText: mandates.sourceText,
  readback: mandates.readback,
  policy: mandates.policy,
  status: mandates.status,
  confirmedAt: mandates.confirmedAt,
  expiresAt: mandates.expiresAt,
};
type LockedMandate = Pick<typeof mandates.$inferSelect, keyof typeof MANDATE_FIELDS>;

/**
 * Decides a proposed purchase and carries it as far as it can go. The gate decides and the purchase
 * is reserved by reservePurchase; a purchase the gate blocked ends there, with no intent check and no
 * call to PayPal. Otherwise the intent check reads the buyer's own request and mandate beside the
 * cart, and its result can only tighten the gate's verdict: a check that throws counts as
 * unavailable, which sends the purchase to its buyer. The result and the final verdict are stored,
 * and the final verdict routed: BLOCK leaves the purchase `blocked`, ALLOW charges the buyer's saved
 * wallet with chargeAllowed, and ASK asks the buyer to approve at PayPal with startApproval. Returns
 * where the purchase then stands. Throws, recording nothing, for a buyer who never had a mandate.
 */
export async function proposePurchase(deps: PurchaseDeps, i: ProposalRequest): Promise<ProposalOutcome> {
  const { purchaseId, gateVerdict, check } = await reservePurchase(deps, i);
  if (!check) return purchaseOutcome(deps.db, purchaseId);

  const intent = await runIntentCheck(deps.intent, check);
  const verdict = applyIntent(gateVerdict, intent);
  await recordIntent(deps.db, purchaseId, intent, verdict);
  switch (verdict) {
    case 'ALLOW':
      return chargeAllowed(deps, purchaseId);
    case 'ASK':
      return startApproval(deps, purchaseId);
    case 'BLOCK':
      return purchaseOutcome(deps.db, purchaseId);
  }
}

/**
 * Runs the gate and reserves the purchase in one transaction. It first locks the buyer's active
 * mandate row, never the buyer row, which a mandate confirmation locks, so two proposals for one
 * buyer queue here and the second sees the first's reservation. With no active mandate the gate
 * runs against the buyer's latest one and blocks. Under the lock it loads everything the gate reads
 * from the database: the spend of the buyer's purchases that count against the budget since the
 * period began, when their recent purchases were made, whether a saved wallet is linked, and the
 * proposed seller's listings for the proposed SKUs. It then inserts the purchase, `proposed`, or
 * `blocked` with BLOCK as its final verdict, with the canonical cart, its hash and total and every
 * rule's outcome, and logs the `gate` event. Throws, inserting nothing, for a buyer who never had a
 * mandate.
 */
async function reservePurchase({ db, now: clock }: Pick<PurchaseDeps, 'db' | 'now'>, i: ProposalRequest): Promise<Reserved> {
  return db.transaction(async (tx) => {
    const mandate = await lockMandate(tx, i.buyerId);
    if (!mandate) throw new Error(`buyer ${i.buyerId} has no mandate, so there is nothing to check a purchase against`);
    const now = clock();
    const parsed = PurchaseProposal.safeParse(i.proposal);
    const seller = parsed.success ? await findSeller(tx, parsed.data.sellerSlug) : undefined;
    const catalog =
      seller && parsed.success ? await loadCatalog(tx, seller.id, parsed.data.items.map((item) => item.sku)) : new Map<string, CatalogEntry>();
    const gate = evaluateGateSafely({
      policy: mandate.policy,
      mandate: { status: mandate.status, expiresAt: mandate.expiresAt },
      walletLinked: await hasLinkedWallet(tx, i.buyerId),
      seller: seller ? { slug: seller.slug, name: seller.name } : unknownSeller(parsed.success ? parsed.data.sellerSlug : ''),
      proposal: i.proposal,
      catalog,
      ...(await ledger(tx, i.buyerId, mandate, now)),
      now,
    });

    // The gate blocks whenever it has no cart, so a cart it did not block always goes to the intent check.
    const cart = gate.verdict === 'BLOCK' ? null : gate.cart;
    const [purchase] = await tx
      .insert(purchases)
      .values({
        buyerId: i.buyerId,
        mandateId: mandate.id,
        sellerId: seller?.id ?? null,
        runId: i.runId,
        request: i.request,
        proposal: i.proposal,
        cart: gate.cart,
        cartHash: gate.cart ? hashOf(gate.cart) : null,
        totalCents: gate.cart?.totalCents ?? null,
        gateVerdict: gate.verdict,
        gateReasons: gate.outcomes.filter((o) => o.result !== 'pass' && o.result !== 'skip').map((o) => o.detail),
        gateOutcomes: gate.outcomes,
        rulesetVersion: gate.rulesetVersion,
        finalVerdict: cart ? null : 'BLOCK',
        status: cart ? 'proposed' : 'blocked',
        // When the gate decided, on the clock the budget period and the velocity window are measured by.
        createdAt: now,
      })
      .returning({ id: purchases.id, request: purchases.request });
    // Rule results only: the details can repeat seller-written titles, and stay on the purchase.
    await appendEvent(tx, purchase.id, 'gate', {
      verdict: gate.verdict,
      rulesetVersion: gate.rulesetVersion,
      outcomes: gate.outcomes.map(({ rule, result }) => ({ rule, result })),
    });

    const check: IntentInput | null = cart && {
      mandateText: mandate.sourceText,
      readback: mandate.readback,
      request: purchase.request,
      cart,
      agentRationale: i.proposal.rationale,
    };
    return { purchaseId: purchase.id, gateVerdict: gate.verdict, check };
  });
}

/**
 * Locks and returns the buyer's active mandate, or, when they have none, their latest mandate, which
 * the gate blocks. Undefined for a buyer who never had a mandate.
 */
async function lockMandate(tx: Db, buyerId: string): Promise<LockedMandate | undefined> {
  const [active] = await tx
    .select(MANDATE_FIELDS)
    .from(mandates)
    .where(and(eq(mandates.buyerId, buyerId), eq(mandates.status, 'active')))
    .for('update');
  if (active) return active;
  // Locked too: a mandate confirmed since the first read would otherwise reach the gate unlocked.
  const [latest] = await tx
    .select(MANDATE_FIELDS)
    .from(mandates)
    .where(eq(mandates.buyerId, buyerId))
    .orderBy(desc(mandates.createdAt))
    .limit(1)
    .for('update');
  return latest;
}

/**
 * The buyer's spend in the current budget period and when their purchases in the velocity window
 * were made, both counting every purchase in a status that holds budget, purchases still in flight
 * included. A policy that does not parse makes the gate block, so nothing is loaded for it.
 */
async function ledger(
  tx: Db,
  buyerId: string,
  mandate: LockedMandate,
  now: Date,
): Promise<Pick<GateInput, 'spentInPeriodCents' | 'recentPurchaseTimes'>> {
  const policy = MandatePolicy.safeParse(mandate.policy);
  if (!policy.success) return { spentInPeriodCents: 0, recentPurchaseTimes: [] };
  const holdsBudget = and(eq(purchases.buyerId, buyerId), inArray(purchases.status, [...COUNTS_AGAINST_BUDGET]));

  const start = periodStart(policy.data.budget.period, now, mandate.confirmedAt);
  const [{ spent }] = await tx
    .select({ spent: sum(purchases.totalCents) })
    .from(purchases)
    .where(and(holdsBudget, gte(purchases.createdAt, start)));

  const { velocity } = policy.data;
  const recent =
    velocity === null
      ? []
      : await tx
          .select({ at: purchases.createdAt })
          .from(purchases)
          .where(and(holdsBudget, gt(purchases.createdAt, new Date(now.getTime() - velocity.windowHours * HOUR_MS))));
  return { spentInPeriodCents: Number(spent ?? 0), recentPurchaseTimes: recent.map((p) => p.at) };
}

async function findSeller(tx: Db, slug: string) {
  const [seller] = await tx
    .select({ id: sellers.id, slug: sellers.slug, name: sellers.name })
    .from(sellers)
    .where(eq(sellers.slug, slug));
  return seller;
}

/**
 * The seller as the gate is told of one Behest does not know: named only by the agent's slug, quoted,
 * and with an empty catalog, so every proposed SKU is missing and the gate blocks.
 */
function unknownSeller(slug: string): GateInput['seller'] {
  return { slug, name: quoteAgentText(slug) };
}

/** The seller's listings of the given SKUs, by SKU. Other sellers' listings of the same SKUs never price this cart. */
async function loadCatalog(tx: Db, sellerId: string, skus: string[]): Promise<Map<string, CatalogEntry>> {
  const rows = await tx
    .select({
      sku: products.sku,
      title: products.title,
      category: products.category,
      priceCents: products.priceCents,
      stock: products.stock,
      flags: products.flags,
      marketMedianCents: products.marketMedianCents,
    })
    .from(products)
    .where(and(eq(products.sellerId, sellerId), inArray(products.sku, skus)));
  return new Map(rows.map((row) => [row.sku, row]));
}

/** Whether the buyer has a saved wallet that a charge could use, as chargeAllowed looks for it. */
async function hasLinkedWallet(tx: Db, buyerId: string): Promise<boolean> {
  const [wallet] = await tx
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.buyerId, buyerId), eq(wallets.status, 'linked'), isNotNull(wallets.paymentTokenId)));
  return wallet !== undefined;
}

/** The intent check's answer. A check that throws counts as unavailable, which sends the purchase to its buyer. */
async function runIntentCheck(intent: PurchaseDeps['intent'], input: IntentInput): Promise<IntentResult> {
  try {
    return await intent(input);
  } catch (error) {
    console.error('The intent check failed, so the purchase goes to its buyer:', error);
    return { verdict: 'unavailable', reasons: [CHECK_FAILED] };
  }
}

/**
 * Stores the intent check's result and the final verdict, logs them as the `intent` event, and moves
 * a purchase the check blocked to `blocked`, all in one transaction. The event carries the verdicts
 * only: the check's reasons can repeat seller-written titles, and stay on the purchase.
 */
async function recordIntent(db: Db, purchaseId: string, intent: IntentResult, verdict: Verdict): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(purchases)
      .set({ intent: { verdict: intent.verdict, reasons: intent.reasons }, finalVerdict: verdict })
      .where(eq(purchases.id, purchaseId));
    await appendEvent(tx, purchaseId, 'intent', { verdict: intent.verdict, finalVerdict: verdict });
    if (verdict === 'BLOCK') await transition(tx, purchaseId, 'proposed', 'blocked');
  });
}
