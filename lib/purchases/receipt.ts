import { eq } from 'drizzle-orm';
import { decodeProtectedHeader } from 'jose';
import type { Db } from '@/lib/db/client';
import { mandates, purchases, receipts, sellers } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { cartClaims } from '@/lib/receipts/verify-receipt';
import type { PurchaseDeps } from './deps';
import { appendEvent } from './events';

// The signed receipt of a captured purchase (architecture section 5.3): the artifact the seller
// verifies with only Behest's public key, and the core of a dispute's evidence pack. A purchase has
// at most one receipt, which the unique `receipts.purchase_id` enforces.

type ReceiptDeps = Pick<PurchaseDeps, 'db' | 'signer' | 'now'>;
type IssuedReceipt = { receiptId: string; jws: string };

/**
 * Signs and stores the receipt of a captured purchase, logging a `receipt` event with it, and
 * returns its id and JWS. Safe to call again, even while an earlier call is still going: once a
 * purchase has a receipt, every call returns that one. Throws, storing nothing, for a purchase
 * whose payment has not been captured or whose decision cannot go on a receipt.
 */
export async function issueReceipt(deps: ReceiptDeps, purchaseId: string): Promise<IssuedReceipt> {
  const { db } = deps;
  const existing = await storedReceipt(db, purchaseId);
  if (existing) return existing;

  const payload = await receiptPayload(deps, purchaseId);
  const jws = await deps.signer.sign(payload, 'behest-receipt+jws');
  const { kid } = decodeProtectedHeader(jws);
  if (!kid) throw new Error('the signer did not name its key in the receipt header');

  const stored = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(receipts)
      .values({ id: payload.id, purchaseId, jws, payloadHash: hashOf(payload), keyId: kid })
      .onConflictDoNothing({ target: receipts.purchaseId })
      .returning({ id: receipts.id });
    if (row) await appendEvent(tx, purchaseId, 'receipt', { receiptId: row.id });
    return row;
  });
  if (stored) return { receiptId: payload.id, jws };

  // Another call stored its receipt first. This one was never shown to anyone, so it is dropped.
  const winner = await storedReceipt(db, purchaseId);
  if (!winner) throw new Error(`the receipt of purchase ${purchaseId} was neither stored nor found`);
  return winner;
}

async function storedReceipt(db: Db, purchaseId: string): Promise<IssuedReceipt | undefined> {
  const [row] = await db
    .select({ receiptId: receipts.id, jws: receipts.jws })
    .from(receipts)
    .where(eq(receipts.purchaseId, purchaseId));
  return row;
}

/** What a receipt is built from: the purchase, its mandate and its seller. */
type ReceiptSource = {
  purchase: typeof purchases.$inferSelect;
  mandate: { id: string; policyHash: string; jws: string };
  sellerSlug: string;
};

async function receiptSource(db: Db, purchaseId: string): Promise<ReceiptSource | undefined> {
  const [row] = await db
    .select({
      purchase: purchases,
      mandate: { id: mandates.id, policyHash: mandates.policyHash, jws: mandates.jws },
      sellerSlug: sellers.slug,
    })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .innerJoin(sellers, eq(sellers.id, purchases.sellerId))
    .where(eq(purchases.id, purchaseId));
  return row;
}

/**
 * Why a purchase could not be given a receipt once its payment is captured, or null if it could.
 * The charge asks this before PayPal is, so money never moves for a purchase whose receipt would
 * then fail. Beyond the named checks, every claim is checked against the strict schema, with
 * stand-ins for the payment PayPal has yet to make.
 */
export async function receiptBlocker(db: Db, purchaseId: string, now: Date): Promise<string | null> {
  const source = await receiptSource(db, purchaseId);
  if (!source) return 'The purchase has no seller to name on its receipt.';
  const { purchase, mandate } = source;
  if (!purchase.cart || purchase.totalCents === null) return 'The purchase has no cart to put on its receipt.';
  if (purchase.gateOutcomes.length === 0) return 'The purchase has no gate outcomes to put on its receipt.';
  if (!mandate.jws) return "The purchase's mandate has no signature to cite on its receipt.";
  const verdict = purchase.finalVerdict;
  if (verdict !== 'ALLOW' && verdict !== 'ASK') return 'The purchase has no verdict a receipt can carry.';
  const draft = receiptClaims(source, purchase.cart, verdict, now, {
    processor: 'paypal',
    orderId: 'pending',
    captureId: 'pending',
    amountCents: purchase.totalCents,
    capturedAt: now.toISOString(),
  });
  return ReceiptPayload.safeParse(draft).success ? null : 'The purchase could not be given a valid receipt.';
}

/**
 * Builds a new receipt's claims for the captured purchase and checks them against the strict
 * schema, so a malformed receipt is never signed.
 */
async function receiptPayload({ db, now }: ReceiptDeps, purchaseId: string): Promise<ReceiptPayload> {
  const source = await receiptSource(db, purchaseId);
  if (!source) throw new Error(`there is no purchase ${purchaseId} with a seller`);
  const { purchase } = source;
  if (purchase.status !== 'captured') {
    throw new Error(`purchase ${purchaseId} is ${purchase.status}, and a receipt is issued only once its payment is captured`);
  }
  const { cart, totalCents, paypalOrderId, paypalCaptureId, capturedAt, finalVerdict } = purchase;
  if (!cart || totalCents === null || !paypalOrderId || !paypalCaptureId || !capturedAt) {
    throw new Error(`captured purchase ${purchaseId} is missing its cart, total or capture`);
  }
  if (finalVerdict !== 'ALLOW' && finalVerdict !== 'ASK') {
    throw new Error(`purchase ${purchaseId} has the final verdict ${finalVerdict}, and only an allowed or approved purchase gets a receipt`);
  }
  return ReceiptPayload.parse(
    receiptClaims(source, cart, finalVerdict, now(), {
      processor: 'paypal',
      orderId: paypalOrderId,
      captureId: paypalCaptureId,
      amountCents: totalCents,
      capturedAt: capturedAt.toISOString(),
    }),
  );
}

/** A receipt's claims, before they are checked: everything but the payment comes from `source`. */
function receiptClaims(
  { purchase, mandate, sellerSlug }: ReceiptSource,
  cart: Cart,
  verdict: 'ALLOW' | 'ASK',
  issuedAt: Date,
  payment: ReceiptPayload['payment'],
): ReceiptPayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: Math.floor(issuedAt.getTime() / 1000),
    mandate: { id: mandate.id, policyHash: mandate.policyHash, jwsHash: sha256Hex(mandate.jws) },
    seller: { slug: sellerSlug },
    cart: cartClaims(cart),
    decision: {
      purchaseId: purchase.id,
      verdict,
      approver: verdict === 'ALLOW' ? 'policy' : 'human',
      rulesetVersion: purchase.rulesetVersion,
      outcomes: purchase.gateOutcomes.map(({ rule, result }) => ({ rule, result })),
    },
    payment,
  };
}
