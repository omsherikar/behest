import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes, mandates, purchaseEvents, purchases, receipts, sellers, wallets } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { formatUsd } from '@/lib/domain/money';
import { wrapUntrusted } from '@/lib/llm/untrusted';
import { hashOf } from '@/lib/receipts/canonical';

// The evidence Behest answers a dispute with (architecture section 5.5), assembled by plain code from
// its own records: the signed mandate, the readback the buyer confirmed, the signed receipt, the cart,
// the purchase's event log and, for a purchase the buyer approved, the approval. Behest records no
// shipment tracking yet, so no pack has a tracking item.
//
// Text written by others is quoted where the pack writes it, with wrapUntrusted, so the evidence agent
// reads it as data: the gate and intent reasons, which can hold seller-written titles, what a seller
// answered, and errors PayPal sent back. Nothing in a pack names the buyer, their wallet's ids or the
// seller's payout email: the log drops each such field and blanks out any such value it still finds.

export const EVIDENCE_IDS = ['mandate', 'readback', 'receipt', 'cart', 'purchase_log', 'approval', 'tracking'] as const;
export type EvidenceId = (typeof EVIDENCE_IDS)[number];

export type EvidenceItem = { id: EvidenceId; title: string; body: string };
export type EvidencePack = { disputeId: string; purchaseId: string; items: EvidenceItem[] };

/** Logged fields that hold the buyer's id, a wallet's ids or a payout email, such as the `paymentTokenId` of a charge. */
const PRIVATE_FIELDS: ReadonlySet<string> = new Set([
  'buyerId',
  'paymentTokenId',
  'setupTokenId',
  'paypalCustomerId',
  'customerId',
  'payoutEmail',
  'receiverEmail',
]);
/** Shorter values are not blanked out of the log, so a private field holding a common word cannot blank it everywhere. */
const MIN_PRIVATE_CHARS = 6;
const REDACTED = '[redacted]';
/** How much of each quoted text the pack keeps, in characters inside its untrusted tag. */
const MAX_QUOTED_CHARS = 2_000;

type Purchase = typeof purchases.$inferSelect;
type Mandate = typeof mandates.$inferSelect;
type Receipt = typeof receipts.$inferSelect;
type PurchaseEvent = { kind: string; data: Record<string, unknown>; createdAt: Date };

/**
 * The evidence pack for the dispute whose row id is `disputeId`, with the receipt verification link
 * built on `appOrigin`, Behest's public origin. The receipt item is left out for a purchase that was
 * never given one, and the approval item is there only for a purchase that needed the buyer's
 * approval. Throws for a dispute that does not exist or is not yet matched to a purchase.
 */
export async function assembleEvidencePack(db: Db, disputeId: string, appOrigin: string): Promise<EvidencePack> {
  const verifyUrl = new URL('/api/receipts/verify', appOrigin).href;

  const [dispute] = await db
    .select({ purchaseId: disputes.purchaseId })
    .from(disputes)
    .where(eq(disputes.id, disputeId));
  if (!dispute) throw new Error(`there is no dispute ${disputeId}`);
  const { purchaseId } = dispute;
  if (!purchaseId) throw new Error(`dispute ${disputeId} is not matched to a purchase`);

  const [row] = await db
    .select({ purchase: purchases, mandate: mandates, receipt: receipts, payoutEmail: sellers.payoutEmail })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .leftJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .leftJoin(sellers, eq(sellers.id, purchases.sellerId))
    .where(eq(purchases.id, purchaseId));
  if (!row) throw new Error(`there is no purchase ${purchaseId} with a mandate`);
  const { purchase, mandate, receipt, payoutEmail } = row;
  if (!purchase.cart) throw new Error(`purchase ${purchaseId} has no cart`);

  const events = await db
    .select({ kind: purchaseEvents.kind, data: purchaseEvents.data, createdAt: purchaseEvents.createdAt })
    .from(purchaseEvents)
    .where(eq(purchaseEvents.purchaseId, purchaseId))
    .orderBy(asc(purchaseEvents.seq));
  const [wallet] = await db
    .select({ paymentTokenId: wallets.paymentTokenId, setupTokenId: wallets.setupTokenId, customerId: wallets.paypalCustomerId })
    .from(wallets)
    .where(eq(wallets.buyerId, purchase.buyerId));

  const items: EvidenceItem[] = [
    { id: 'mandate', title: 'Signed mandate', body: mandateBody(mandate) },
    { id: 'readback', title: 'Readback the buyer confirmed', body: readbackBody(mandate) },
  ];
  if (receipt) items.push({ id: 'receipt', title: 'Signed receipt', body: receiptBody(receipt, verifyUrl) });
  items.push({ id: 'cart', title: 'Cart', body: cartBody(purchase.cart) });
  const privateValues = [purchase.buyerId, wallet?.paymentTokenId, wallet?.setupTokenId, wallet?.customerId, payoutEmail];
  items.push({ id: 'purchase_log', title: 'Purchase log', body: logBody(purchase, events, privateValues) });
  if (purchase.finalVerdict === 'ASK' || purchase.approver === 'human') {
    items.push({ id: 'approval', title: "The buyer's approval", body: approvalBody(purchase, events) });
  }
  return { disputeId, purchaseId, items };
}

function mandateBody(mandate: Mandate): string {
  return [
    `Mandate ${mandate.id}, signed by Behest when the buyer confirmed it at ${mandate.confirmedAt.toISOString()}.`,
    `Expires: ${mandate.expiresAt?.toISOString() ?? 'never'}.`,
    `Policy hash: ${mandate.policyHash}`,
    '',
    "The mandate in the buyer's own words:",
    mandate.sourceText,
    '',
    'The signed mandate, a compact JWS:',
    mandate.jws,
  ].join('\n');
}

function readbackBody(mandate: Mandate): string {
  return [
    `The limits Behest enforces for mandate ${mandate.id}, as the buyer confirmed them:`,
    ...mandate.readback.map((line) => `- ${line}`),
    '',
    `Readback hash: ${mandate.readbackHash}, which the signed mandate also carries.`,
  ].join('\n');
}

function receiptBody(receipt: Receipt, verifyUrl: string): string {
  return [
    `Receipt ${receipt.id}, signed by Behest with key ${receipt.keyId} at ${receipt.createdAt.toISOString()}.`,
    `Payload hash: ${receipt.payloadHash}`,
    `Anyone can check it with Behest's public key, or by posting it to ${verifyUrl}.`,
    '',
    'The signed receipt, a compact JWS:',
    receipt.jws,
  ].join('\n');
}

/** The cart as listed, with the hash of exactly that cart, which is what a receipt signed for it carries. */
function cartBody(cart: Cart): string {
  return [
    `Seller: ${cart.seller.name} (${cart.seller.slug})`,
    ...cart.items.map(
      (item) =>
        `- ${item.quantity} x ${item.title} (SKU ${item.sku}, ${item.category}) at ${formatUsd(item.unitPriceCents)} each: ${formatUsd(item.unitPriceCents * item.quantity)}`,
    ),
    `Total: ${formatUsd(cart.totalCents)} ${cart.currency}`,
    `Cart hash: ${hashOf(cart)}. A receipt signed for this cart carries the same hash.`,
  ].join('\n');
}

function approverText(approver: Purchase['approver']): string {
  if (approver === 'human') return 'the buyer';
  if (approver === 'policy') return "the buyer's mandate";
  return 'not recorded';
}

/**
 * Who wrote a logged free-text field, for the fields others wrote: a seller's answers, and the errors
 * PayPal calls ended with. Null for Behest's own wording, such as why it refused to charge.
 */
function quoteSource(kind: string, field: string): string | null {
  if (field !== 'reason' && field !== 'error') return null;
  if (kind.startsWith('seller_')) return 'seller_listing';
  return field === 'error' ? 'paypal_error' : null;
}

/**
 * The purchase and every event logged for it, in order, with the free text others wrote quoted.
 * Private fields are dropped, and any of `privateValues`, or a value a private field held, that still
 * appears, for example in an error PayPal sent back, is blanked out.
 */
function logBody(purchase: Purchase, events: PurchaseEvent[], privateValues: (string | null | undefined)[]): string {
  const hidden = new Set<string>();
  for (const value of privateValues) hide(value, hidden);
  const steps = events.map((event, index) => {
    const data = publicFields(event.data, hidden);
    const quoted: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      const source = quoteSource(event.kind, field);
      if (!source || typeof value !== 'string') continue;
      delete data[field];
      quoted.push(` ${field}: ${wrapUntrusted(source, value, MAX_QUOTED_CHARS)}`);
    }
    const shown = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    return `${index + 1}. ${event.createdAt.toISOString()} ${event.kind}${shown}${quoted.join('')}`;
  });
  const payment = purchase.paypalCaptureId
    ? `PayPal order ${purchase.paypalOrderId}, capture ${purchase.paypalCaptureId}, captured at ${purchase.capturedAt?.toISOString() ?? 'an unrecorded time'}.`
    : 'No PayPal capture is recorded.';
  const text = [
    `Purchase ${purchase.id}, created at ${purchase.createdAt.toISOString()}.`,
    `The buyer's request to the agent: ${purchase.request}`,
    `Gate verdict: ${purchase.gateVerdict} under ruleset ${purchase.rulesetVersion}. Final verdict: ${purchase.finalVerdict ?? 'none'}, approved by ${approverText(purchase.approver)}.`,
    payment,
    `Status now: ${purchase.status}.`,
    '',
    'Every recorded step, in order:',
    ...steps,
  ].join('\n');
  // Longest first, so a value that contains another is blanked out whole.
  return [...hidden].sort((a, b) => b.length - a.length).reduce((out, value) => out.replaceAll(value, REDACTED), text);
}

/** Adds every string in `value`, at any depth, to `hidden`, except those too short to blank out safely. */
function hide(value: unknown, hidden: Set<string>): void {
  if (typeof value === 'string') {
    if (value.length >= MIN_PRIVATE_CHARS) hidden.add(value);
  } else if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) hide(inner, hidden);
  }
}

/** `value` without its private fields, at any depth. Everything they held is added to `hidden`. */
function publicFields(value: Record<string, unknown>, hidden: Set<string>): Record<string, unknown> {
  const visit = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(visit);
    if (typeof inner !== 'object' || inner === null) return inner;
    const kept: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(inner)) {
      if (PRIVATE_FIELDS.has(key)) hide(field, hidden);
      else kept[key] = visit(field);
    }
    return kept;
  };
  return visit(value) as Record<string, unknown>;
}

/**
 * Why the purchase needed the buyer, read as purchaseOutcome reads it: the details of the gate rules
 * that did not pass, then the intent check's reasons. Both can hold seller-written titles, so each is
 * quoted.
 */
function approvalBody(purchase: Purchase, events: PurchaseEvent[]): string {
  const failedRules = purchase.gateOutcomes.filter((o) => o.result !== 'pass' && o.result !== 'skip').map((o) => o.detail);
  const reasons = [...failedRules, ...(purchase.intent?.reasons ?? [])];
  const steps = events.flatMap(({ kind, data, createdAt }) => {
    if (kind !== 'status' || (data.from !== 'awaiting_approval' && data.to !== 'awaiting_approval')) return [];
    return [`- ${createdAt.toISOString()} ${String(data.from)} to ${String(data.to)}`];
  });
  return [
    `This purchase needed the buyer's approval before it was paid (final verdict ${purchase.finalVerdict ?? 'none'}).`,
    `Approved by: ${approverText(purchase.approver)}`,
    `PayPal order the buyer approved: ${purchase.paypalOrderId ?? 'none recorded'}`,
    '',
    'Why it needed the buyer:',
    ...(reasons.length > 0
      ? reasons.map((reason) => `- ${wrapUntrusted('seller_listing', reason, MAX_QUOTED_CHARS)}`)
      : ['- No reason was recorded.']),
    '',
    'Approval steps from the purchase log:',
    ...(steps.length > 0 ? steps : ['- None recorded.']),
  ].join('\n');
}
