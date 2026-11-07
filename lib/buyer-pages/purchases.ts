import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { type PurchaseStatus, purchases, receipts, sellers } from '@/lib/db/schema';
import type { Verdict } from '@/lib/domain/verdict';
import { paypalApproveUrl } from './approve-url';
import { purchaseReasons } from './reasons';

// The buyer's own purchases, for the approvals and ledger pages. Each query is scoped to one buyer.
// Seller names, item titles and reasons may be text a seller wrote, so the pages show them as text.

/** A purchase waiting for the buyer to approve it at PayPal. */
export type PendingApproval = {
  id: string;
  createdAt: Date;
  seller: string;
  totalCents: number | null;
  items: { sku: string; title: string; quantity: number; unitPriceCents: number }[];
  /** Why Behest asks: the failed gate rules' details, then the intent check's reasons. */
  reasons: string[];
  /** The PayPal link to approve it, or null when there is none or the stored one is not an https PayPal page. */
  approveUrl: string | null;
};

/** One purchase in the buyer's ledger. Plain values only: the rows go to the browser for the grid. */
export type LedgerRow = {
  id: string;
  /** When the agent proposed it, as an ISO timestamp. */
  createdAt: string;
  seller: string;
  /** Null for a purchase the gate blocked before it could price a cart. */
  totalCents: number | null;
  /** The final verdict, or the gate's when the intent check has not run. */
  verdict: Verdict;
  status: PurchaseStatus;
  reasons: string[];
  receiptId: string | null;
};

/** The seller as the buyer knows it: Behest's record, else the slug the agent proposed for a seller Behest does not know. */
function sellerOf(row: { sellerName: string | null; proposal: { sellerSlug: string } }): string {
  return row.sellerName ?? row.proposal.sellerSlug;
}

/** The buyer's purchases waiting for approval at PayPal, newest first. */
export async function pendingApprovals(db: Db, buyerId: string): Promise<PendingApproval[]> {
  const rows = await db
    .select({
      id: purchases.id,
      createdAt: purchases.createdAt,
      sellerName: sellers.name,
      proposal: purchases.proposal,
      cart: purchases.cart,
      totalCents: purchases.totalCents,
      gateOutcomes: purchases.gateOutcomes,
      intent: purchases.intent,
      approveUrl: purchases.approveUrl,
    })
    .from(purchases)
    .leftJoin(sellers, eq(sellers.id, purchases.sellerId))
    .where(and(eq(purchases.buyerId, buyerId), eq(purchases.status, 'awaiting_approval')))
    .orderBy(desc(purchases.createdAt), desc(purchases.id));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    seller: sellerOf(row),
    totalCents: row.totalCents,
    items: (row.cart?.items ?? []).map(({ sku, title, quantity, unitPriceCents }) => ({ sku, title, quantity, unitPriceCents })),
    reasons: purchaseReasons(row),
    approveUrl: paypalApproveUrl(row.approveUrl),
  }));
}

/** Every purchase of the buyer's, newest first, as the ledger shows it. */
export async function ledgerRows(db: Db, buyerId: string): Promise<LedgerRow[]> {
  const rows = await db
    .select({
      id: purchases.id,
      createdAt: purchases.createdAt,
      sellerName: sellers.name,
      proposal: purchases.proposal,
      totalCents: purchases.totalCents,
      gateVerdict: purchases.gateVerdict,
      finalVerdict: purchases.finalVerdict,
      status: purchases.status,
      gateOutcomes: purchases.gateOutcomes,
      intent: purchases.intent,
      receiptId: receipts.id,
    })
    .from(purchases)
    .leftJoin(sellers, eq(sellers.id, purchases.sellerId))
    .leftJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .where(eq(purchases.buyerId, buyerId))
    .orderBy(desc(purchases.createdAt), desc(purchases.id));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    seller: sellerOf(row),
    totalCents: row.totalCents,
    verdict: row.finalVerdict ?? row.gateVerdict,
    status: row.status,
    reasons: purchaseReasons(row),
    receiptId: row.receiptId,
  }));
}
