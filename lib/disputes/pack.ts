import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes, mandates, purchaseEvents, purchases, receipts, wallets } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { formatUsd } from '@/lib/domain/money';

// The evidence Behest answers a dispute with (architecture section 5.5), assembled by plain code from
// its own records: the signed mandate, the readback the buyer confirmed, the signed receipt, the cart,
// the purchase's event log and, for a purchase the buyer approved, the approval. Behest records no
// shipment tracking yet, so no pack has a tracking item. Nothing in a pack names the buyer or any of
// their wallet's ids: the log drops every such field and blanks out any such id it still finds.

export const EVIDENCE_IDS = ['mandate', 'readback', 'receipt', 'cart', 'purchase_log', 'approval', 'tracking'] as const;
export type EvidenceId = (typeof EVIDENCE_IDS)[number];

export type EvidenceItem = { id: EvidenceId; title: string; body: string };
export type EvidencePack = { disputeId: string; purchaseId: string; items: EvidenceItem[] };

/** Logged fields that hold the buyer's id or a wallet's ids, such as the `paymentTokenId` of a charge. */
const PRIVATE_FIELD = /token|customer|buyer|payer|wallet|vault/i;
const REDACTED = '[redacted]';

type Purchase = typeof purchases.$inferSelect;
type Mandate = typeof mandates.$inferSelect;
type Receipt = typeof receipts.$inferSelect;
type PurchaseEvent = { kind: string; data: Record<string, unknown>; createdAt: Date };

/**
 * The evidence pack for the dispute whose row id is `disputeId`. The receipt item is left out for a
 * purchase that was never given one, and the approval item is there only for a purchase that needed
 * the buyer's approval. Throws for a dispute that does not exist or is not yet matched to a
 * purchase, and when APP_URL, the base of the receipt verification link, is not set.
 */
export async function assembleEvidencePack(db: Db, disputeId: string): Promise<EvidencePack> {
  const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (!appUrl) throw new Error("APP_URL must be set to Behest's public base URL, for the receipt verification link");

  const [dispute] = await db
    .select({ purchaseId: disputes.purchaseId })
    .from(disputes)
    .where(eq(disputes.id, disputeId));
  if (!dispute) throw new Error(`there is no dispute ${disputeId}`);
  const { purchaseId } = dispute;
  if (!purchaseId) throw new Error(`dispute ${disputeId} is not matched to a purchase`);

  const [row] = await db
    .select({ purchase: purchases, mandate: mandates, receipt: receipts })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .leftJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!row) throw new Error(`there is no purchase ${purchaseId} with a mandate`);
  const { purchase, mandate, receipt } = row;
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
  if (receipt) items.push({ id: 'receipt', title: 'Signed receipt', body: receiptBody(receipt, appUrl) });
  items.push({ id: 'cart', title: 'Cart', body: cartBody(purchase.cart, purchase.cartHash) });
  const privateIds = [purchase.buyerId, wallet?.paymentTokenId, wallet?.setupTokenId, wallet?.customerId];
  items.push({ id: 'purchase_log', title: 'Purchase log', body: logBody(purchase, events, privateIds) });
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

function receiptBody(receipt: Receipt, appUrl: string): string {
  return [
    `Receipt ${receipt.id}, signed by Behest with key ${receipt.keyId} at ${receipt.createdAt.toISOString()}.`,
    `Payload hash: ${receipt.payloadHash}`,
    `Anyone can check it with Behest's public key, or by posting it to ${appUrl}/api/receipts/verify.`,
    '',
    'The signed receipt, a compact JWS:',
    receipt.jws,
  ].join('\n');
}

function cartBody(cart: Cart, cartHash: string | null): string {
  return [
    `Seller: ${cart.seller.name} (${cart.seller.slug})`,
    ...cart.items.map(
      (item) =>
        `- ${item.quantity} x ${item.title} (SKU ${item.sku}, ${item.category}) at ${formatUsd(item.unitPriceCents)} each: ${formatUsd(item.unitPriceCents * item.quantity)}`,
    ),
    `Total: ${formatUsd(cart.totalCents)} ${cart.currency}`,
    ...(cartHash ? [`Cart hash: ${cartHash}, which the signed receipt also carries.`] : []),
  ].join('\n');
}

function approverText(approver: Purchase['approver']): string {
  if (approver === 'human') return 'the buyer';
  if (approver === 'policy') return "the buyer's mandate";
  return 'not recorded';
}

/**
 * The purchase and every event logged for it, in order. Fields that name the buyer or a wallet are
 * dropped, and any of `privateIds`, or a value such a field held, that still appears, for example in
 * an error PayPal sent back, is blanked out.
 */
function logBody(purchase: Purchase, events: PurchaseEvent[], privateIds: (string | null | undefined)[]): string {
  const hidden = new Set(privateIds.filter((id): id is string => Boolean(id)));
  const steps = events.map((event, index) => {
    const data = publicFields(event.data, hidden);
    const shown = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    return `${index + 1}. ${event.createdAt.toISOString()} ${event.kind}${shown}`;
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
  // Longest first, so an id that contains another is blanked out whole.
  return [...hidden].sort((a, b) => b.length - a.length).reduce((out, id) => out.replaceAll(id, REDACTED), text);
}

/** `value` without the fields PRIVATE_FIELD names, at any depth. The strings they held are added to `hidden`. */
function publicFields(value: Record<string, unknown>, hidden: Set<string>): Record<string, unknown> {
  const visit = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(visit);
    if (typeof inner !== 'object' || inner === null) return inner;
    const kept: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(inner)) {
      if (!PRIVATE_FIELD.test(key)) kept[key] = visit(field);
      else if (typeof field === 'string' && field !== '') hidden.add(field);
    }
    return kept;
  };
  return visit(value) as Record<string, unknown>;
}

function approvalBody(purchase: Purchase, events: PurchaseEvent[]): string {
  const reasons = [...purchase.gateReasons, ...(purchase.intent?.reasons ?? [])];
  const steps = events.flatMap(({ kind, data, createdAt }) => {
    if (kind !== 'status' || (data.from !== 'awaiting_approval' && data.to !== 'awaiting_approval')) return [];
    return [`- ${createdAt.toISOString()} ${String(data.from)} to ${String(data.to)}`];
  });
  return [
    `This purchase needed the buyer's approval before it was paid (final verdict ${purchase.finalVerdict ?? 'none'}).`,
    `Approved by: ${approverText(purchase.approver)}`,
    '',
    'Why it needed the buyer:',
    ...(reasons.length > 0 ? reasons.map((reason) => `- ${reason}`) : ['- No reason was recorded.']),
    '',
    'Approval steps from the purchase log:',
    ...(steps.length > 0 ? steps : ['- None recorded.']),
  ].join('\n');
}
