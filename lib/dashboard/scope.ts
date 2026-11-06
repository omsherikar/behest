import { asc, desc, eq, type SQL } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import {
  buyers,
  mandates,
  type MandateStatus,
  payouts,
  products,
  purchaseEvents,
  purchases,
  type PurchaseStatus,
  receipts,
  sellers,
  type StoredIntentResult,
  type StoredRuleOutcome,
} from '@/lib/db/schema';
import { DEMO_BUYER_NAME, DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import type { Cart } from '@/lib/domain/cart';
import type { Category } from '@/lib/domain/categories';
import type { MandatePolicy } from '@/lib/domain/policy';
import type { Verdict } from '@/lib/domain/verdict';
import { TRANSACTION_SEARCH_MAX_DAYS, type Transaction } from '@/lib/paypal';
import type { Persona } from '@/lib/session';
import { transactionRows, type DashboardTransaction } from './transactions';

// The rows behind the dashboard, scoped to whoever is viewing it. The buyer persona sees the demo
// buyer's purchases and mandates; the seller persona sees the purchases, receipts and payouts at
// the demo seller and its own catalogue; the operator sees everything, plus the merchant account's
// PayPal transactions for reconciling captures and payouts. Catalogues are public, so the buyer
// sees every seller's. Rows are plain JSON (timestamps as ISO strings), exactly as the data route
// sends them, and leave out what no dashboard view needs: payout emails, approval links, the
// agent's unverified proposal and event payloads.

export type DashboardPurchase = {
  id: string;
  buyerId: string;
  mandateId: string;
  sellerId: string | null;
  request: string;
  cart: Cart | null;
  totalCents: number | null;
  currency: 'USD';
  gateVerdict: Verdict;
  gateOutcomes: StoredRuleOutcome[];
  rulesetVersion: string;
  intent: StoredIntentResult | null;
  finalVerdict: Verdict | null;
  approver: 'policy' | 'human' | null;
  status: PurchaseStatus;
  paypalOrderId: string | null;
  paypalCaptureId: string | null;
  capturedAt: string | null;
  createdAt: string;
};

export type DashboardPurchaseEvent = { id: string; purchaseId: string; seq: number; kind: string; createdAt: string };

export type DashboardReceipt = { id: string; purchaseId: string; jws: string; keyId: string; createdAt: string };

export type DashboardPayout = {
  id: string;
  purchaseId: string;
  sellerId: string;
  amountCents: number;
  currency: 'USD';
  status: string;
  paypalBatchId: string | null;
  paypalItemId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DashboardSeller = { id: string; slug: string; name: string };

export type DashboardProduct = {
  id: string;
  sellerId: string;
  sku: string;
  title: string;
  category: Category;
  priceCents: number;
  currency: 'USD';
  stock: number | null;
  flags: string[];
  marketMedianCents: number | null;
};

export type DashboardMandate = {
  id: string;
  buyerId: string;
  status: MandateStatus;
  policy: MandatePolicy;
  policyHash: string;
  confirmedAt: string;
  expiresAt: string | null;
  createdAt: string;
};

export type DashboardData = {
  persona: Persona;
  /** When the rows were read, as an ISO timestamp. */
  asOf: string;
  purchases: DashboardPurchase[];
  purchaseEvents: DashboardPurchaseEvent[];
  receipts: DashboardReceipt[];
  payouts: DashboardPayout[];
  sellers: DashboardSeller[];
  products: DashboardProduct[];
  mandates: DashboardMandate[];
  /** The operator's PayPal transactions; always empty for the other personas. */
  transactions: DashboardTransaction[];
  /** Data that could not be loaded, in words. The rest of the data is still complete. */
  warnings: string[];
};

export type DashboardDeps = {
  now?: Date;
  /** Reads the merchant account's PayPal transactions between two instants (Transaction Search). */
  loadTransactions: (start: Date, end: Date) => Promise<Transaction[]>;
};

/** Which purchases a persona sees: all of them, those of one buyer or seller, or none. */
type Scope = { kind: 'all' } | { kind: 'buyer'; buyerId: string } | { kind: 'seller'; sellerId: string } | { kind: 'none' };

async function scopeFor(db: Db, persona: Persona): Promise<Scope> {
  if (persona === 'operator') return { kind: 'all' };
  if (persona === 'buyer') {
    const [buyer] = await db
      .select({ id: buyers.id })
      .from(buyers)
      .where(eq(buyers.name, DEMO_BUYER_NAME))
      .orderBy(asc(buyers.createdAt))
      .limit(1);
    return buyer ? { kind: 'buyer', buyerId: buyer.id } : { kind: 'none' };
  }
  const [seller] = await db.select({ id: sellers.id }).from(sellers).where(eq(sellers.slug, DEMO_SELLER_SLUG));
  return seller ? { kind: 'seller', sellerId: seller.id } : { kind: 'none' };
}

/** The condition on `purchases` for a scope; undefined means every purchase. */
function purchaseCondition(scope: Exclude<Scope, { kind: 'none' }>): SQL | undefined {
  if (scope.kind === 'buyer') return eq(purchases.buyerId, scope.buyerId);
  if (scope.kind === 'seller') return eq(purchases.sellerId, scope.sellerId);
  return undefined;
}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

const DAY_MS = 86_400_000;

export async function loadDashboardData(db: Db, persona: Persona, deps: DashboardDeps): Promise<DashboardData> {
  const now = deps.now ?? new Date();
  const scope = await scopeFor(db, persona);
  const warnings: string[] = [];

  const [purchaseRows, eventRows, receiptRows, payoutRows] =
    scope.kind === 'none' ? [[], [], [], []] : await purchaseTables(db, scope);
  const [sellerRows, productRows] = await catalogue(db, scope, persona);
  const mandateRows = await mandatesFor(db, scope);

  let transactions: DashboardTransaction[] = [];
  if (persona === 'operator') {
    try {
      const start = new Date(now.getTime() - TRANSACTION_SEARCH_MAX_DAYS * DAY_MS);
      transactions = transactionRows(await deps.loadTransactions(start, now), purchaseRows);
    } catch (error) {
      warnings.push(`PayPal transactions could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    persona,
    asOf: iso(now),
    purchases: purchaseRows,
    purchaseEvents: eventRows,
    receipts: receiptRows,
    payouts: payoutRows,
    sellers: sellerRows,
    products: productRows,
    mandates: mandateRows,
    transactions,
    warnings,
  };
}

async function purchaseTables(
  db: Db,
  scope: Exclude<Scope, { kind: 'none' }>,
): Promise<[DashboardPurchase[], DashboardPurchaseEvent[], DashboardReceipt[], DashboardPayout[]]> {
  const inScope = purchaseCondition(scope);

  const purchaseRows = await db
    .select({
      id: purchases.id,
      buyerId: purchases.buyerId,
      mandateId: purchases.mandateId,
      sellerId: purchases.sellerId,
      request: purchases.request,
      cart: purchases.cart,
      totalCents: purchases.totalCents,
      currency: purchases.currency,
      gateVerdict: purchases.gateVerdict,
      gateOutcomes: purchases.gateOutcomes,
      rulesetVersion: purchases.rulesetVersion,
      intent: purchases.intent,
      finalVerdict: purchases.finalVerdict,
      approver: purchases.approver,
      status: purchases.status,
      paypalOrderId: purchases.paypalOrderId,
      paypalCaptureId: purchases.paypalCaptureId,
      capturedAt: purchases.capturedAt,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .where(inScope)
    .orderBy(desc(purchases.createdAt));

  const eventRows = await db
    .select({
      id: purchaseEvents.id,
      purchaseId: purchaseEvents.purchaseId,
      seq: purchaseEvents.seq,
      kind: purchaseEvents.kind,
      createdAt: purchaseEvents.createdAt,
    })
    .from(purchaseEvents)
    .innerJoin(purchases, eq(purchaseEvents.purchaseId, purchases.id))
    .where(inScope)
    .orderBy(asc(purchaseEvents.seq));

  const receiptRows = await db
    .select({
      id: receipts.id,
      purchaseId: receipts.purchaseId,
      jws: receipts.jws,
      keyId: receipts.keyId,
      createdAt: receipts.createdAt,
    })
    .from(receipts)
    .innerJoin(purchases, eq(receipts.purchaseId, purchases.id))
    .where(inScope)
    .orderBy(desc(receipts.createdAt));

  const payoutRows = await db
    .select({
      id: payouts.id,
      purchaseId: payouts.purchaseId,
      sellerId: payouts.sellerId,
      amountCents: payouts.amountCents,
      currency: payouts.currency,
      status: payouts.status,
      paypalBatchId: payouts.paypalBatchId,
      paypalItemId: payouts.paypalItemId,
      createdAt: payouts.createdAt,
      updatedAt: payouts.updatedAt,
    })
    .from(payouts)
    .innerJoin(purchases, eq(payouts.purchaseId, purchases.id))
    // A seller's payouts are those paid to it, which are exactly its purchases' payouts.
    .where(scope.kind === 'seller' ? eq(payouts.sellerId, scope.sellerId) : inScope)
    .orderBy(desc(payouts.createdAt));

  return [
    purchaseRows.map((p) => ({ ...p, capturedAt: isoOrNull(p.capturedAt), createdAt: iso(p.createdAt) })),
    eventRows.map((e) => ({ ...e, createdAt: iso(e.createdAt) })),
    receiptRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    payoutRows.map((p) => ({ ...p, createdAt: iso(p.createdAt), updatedAt: iso(p.updatedAt) })),
  ];
}

/** Sellers and products: the seller persona's own, or every seller's for the other personas. */
async function catalogue(db: Db, scope: Scope, persona: Persona): Promise<[DashboardSeller[], DashboardProduct[]]> {
  if (persona === 'seller' && scope.kind !== 'seller') return [[], []];
  const ownSeller = scope.kind === 'seller' ? scope.sellerId : undefined;

  const sellerRows = await db
    .select({ id: sellers.id, slug: sellers.slug, name: sellers.name })
    .from(sellers)
    .where(ownSeller ? eq(sellers.id, ownSeller) : undefined)
    .orderBy(asc(sellers.name));

  const productRows = await db
    .select({
      id: products.id,
      sellerId: products.sellerId,
      sku: products.sku,
      title: products.title,
      category: products.category,
      priceCents: products.priceCents,
      currency: products.currency,
      stock: products.stock,
      flags: products.flags,
      marketMedianCents: products.marketMedianCents,
    })
    .from(products)
    .where(ownSeller ? eq(products.sellerId, ownSeller) : undefined)
    .orderBy(asc(products.sellerId), asc(products.sku));

  return [sellerRows, productRows];
}

/** Mandates belong to buyers: the buyer persona sees its own, the operator all, the seller none. */
async function mandatesFor(db: Db, scope: Scope): Promise<DashboardMandate[]> {
  if (scope.kind === 'none' || scope.kind === 'seller') return [];
  const rows = await db
    .select({
      id: mandates.id,
      buyerId: mandates.buyerId,
      status: mandates.status,
      policy: mandates.policy,
      policyHash: mandates.policyHash,
      confirmedAt: mandates.confirmedAt,
      expiresAt: mandates.expiresAt,
      createdAt: mandates.createdAt,
    })
    .from(mandates)
    .where(scope.kind === 'buyer' ? eq(mandates.buyerId, scope.buyerId) : undefined)
    .orderBy(desc(mandates.confirmedAt));
  return rows.map((m) => ({
    ...m,
    confirmedAt: iso(m.confirmedAt),
    expiresAt: isoOrNull(m.expiresAt),
    createdAt: iso(m.createdAt),
  }));
}
