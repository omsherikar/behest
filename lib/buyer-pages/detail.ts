import { and, desc, eq, type SQL } from 'drizzle-orm';
import { decodeProtectedHeader } from 'jose';
import type { Db } from '@/lib/db/client';
import {
  mandates,
  type PurchaseStatus,
  purchases,
  receipts,
  sellers,
  type StoredIntentResult,
  type StoredRuleOutcome,
} from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import type { Verdict } from '@/lib/domain/verdict';
import { mandateCredentialId, receiptDecisionHash } from '@/lib/ui/signed-claims';
import { type TraceStates, trailFromPurchase } from '@/lib/ui/trail';
import { paypalApproveUrl } from './approve-url';
import { purchaseReasons } from './reasons';
import { changeFor, type ChangeView } from './what-would-change';

// Everything the buyer's pages show about one purchase: the authority trace and the proof behind
// each step (the mandate, every gate rule, the intent check, the PayPal ids, the signed receipt),
// and what would have let it through. Plain values only, so it can go to the browser as it is.
// Seller names, titles and reasons may be a seller's text; the pages show them as text.

export type PurchaseDetail = {
  id: string;
  /** When the agent proposed it, as an ISO timestamp. */
  createdAt: string;
  seller: string;
  /** The seller's slug as Behest knows it, or null for a seller it does not. */
  sellerSlug: string | null;
  totalCents: number | null;
  items: { sku: string; title: string; quantity: number; unitPriceCents: number }[];
  gateVerdict: Verdict;
  finalVerdict: Verdict | null;
  /** The final verdict, or the gate's when the intent check has not run. */
  verdict: Verdict;
  status: PurchaseStatus;
  /** Why it was not simply allowed: failed gate rules, then the intent check's reasons. */
  reasons: string[];
  trace: TraceStates;
  mandate: {
    id: string;
    policyHash: string;
    confirmedAt: string;
    confirmation: 'session' | 'passkey';
    /** The credential id of the passkey that signed it, as the signed mandate names it; null when confirmed by session. */
    credentialId: string | null;
  };
  outcomes: StoredRuleOutcome[];
  intent: StoredIntentResult | null;
  paypal: { orderId: string | null; captureId: string | null; capturedAt: string | null };
  /** The PayPal link to approve it, while it waits for the buyer. */
  approveUrl: string | null;
  /** The signed receipt; `decisionHash` is the agent's decision record it commits to, or null when it names none. */
  receipt: { id: string; keyId: string; jws: string; decisionHash: string | null } | null;
  /** The canonical cart, which the receipt verifier checks the receipt against. */
  cart: Cart | null;
  /** What would have let it through; null for a purchase the gate and the intent check allowed. */
  change: ChangeView | null;
};

/** The key id a JWS's header names, or the stored one when the header cannot be read. */
function keyIdOf(jws: string, stored: string): string {
  try {
    return decodeProtectedHeader(jws).kid ?? stored;
  } catch {
    return stored;
  }
}

/**
 * The buyer's purchases in full, newest first: all of them, those in one status, or the one with
 * `purchaseId`. Each query is scoped to the buyer. `now` decides whether the mandate has since ended.
 */
export async function purchaseDetails(
  db: Db,
  { buyerId, status, purchaseId }: { buyerId: string; status?: PurchaseStatus; purchaseId?: string },
  now: Date,
): Promise<PurchaseDetail[]> {
  const where: SQL[] = [eq(purchases.buyerId, buyerId)];
  if (status) where.push(eq(purchases.status, status));
  if (purchaseId) where.push(eq(purchases.id, purchaseId));

  const rows = await db
    .select({ purchase: purchases, mandate: mandates, sellerName: sellers.name, sellerSlug: sellers.slug, receipt: receipts })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .leftJoin(sellers, eq(sellers.id, purchases.sellerId))
    .leftJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .where(and(...where))
    .orderBy(desc(purchases.createdAt), desc(purchases.id));

  return Promise.all(
    rows.map(async ({ purchase, mandate, sellerName, sellerSlug, receipt }): Promise<PurchaseDetail> => {
      const verdict = purchase.finalVerdict ?? purchase.gateVerdict;
      const allowed = verdict === 'ALLOW' && purchase.intent?.verdict !== 'needs_human';
      return {
        id: purchase.id,
        createdAt: purchase.createdAt.toISOString(),
        seller: sellerName ?? purchase.proposal.sellerSlug,
        sellerSlug,
        totalCents: purchase.totalCents,
        items: (purchase.cart?.items ?? []).map(({ sku, title, quantity, unitPriceCents }) => ({ sku, title, quantity, unitPriceCents })),
        gateVerdict: purchase.gateVerdict,
        finalVerdict: purchase.finalVerdict,
        verdict,
        status: purchase.status,
        reasons: purchaseReasons(purchase),
        trace: trailFromPurchase(purchase.status, purchase.gateVerdict, purchase.finalVerdict, receipt !== null),
        mandate: {
          id: mandate.id,
          policyHash: mandate.policyHash,
          confirmedAt: mandate.confirmedAt.toISOString(),
          confirmation: mandate.confirmation,
          credentialId: mandateCredentialId(mandate.jws),
        },
        outcomes: purchase.gateOutcomes,
        intent: purchase.intent,
        paypal: {
          orderId: purchase.paypalOrderId,
          captureId: purchase.paypalCaptureId,
          capturedAt: purchase.capturedAt?.toISOString() ?? null,
        },
        approveUrl: purchase.status === 'awaiting_approval' ? paypalApproveUrl(purchase.approveUrl) : null,
        receipt: receipt && {
          id: receipt.id,
          keyId: keyIdOf(receipt.jws, receipt.keyId),
          jws: receipt.jws,
          decisionHash: receiptDecisionHash(receipt.jws),
        },
        cart: purchase.cart,
        change: allowed ? null : await changeFor(db, purchase.id, now),
      };
    }),
  );
}
