import { and, asc, eq, inArray } from 'drizzle-orm';
import { decodeJwt, type JWK } from 'jose';
import type { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { disputes, mandates, products, purchaseEvents, purchases, receipts, sellers, wallets } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { DecisionRecord, type DecisionListing, type DecisionStep } from '@/lib/domain/decision';
import { formatUsd } from '@/lib/domain/money';
import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import { removeHiddenCharacters, wrapUntrusted } from '@/lib/llm/untrusted';
import { type PasskeyCheck, verifyMandatePasskey } from '@/lib/mandate/passkey';
import { TICKET_SECONDS } from '@/lib/passkeys/ticket';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { type JwsType, verifyJws } from '@/lib/receipts/sign';

// The evidence Behest answers a dispute with (architecture section 5.5), assembled by plain code from
// its own records: the signed mandate, the readback the buyer confirmed, the signed receipt, the cart,
// the purchase's event log and, for a purchase the buyer approved, the approval. Behest records no
// shipment tracking yet, so no pack has a tracking item. The mandate item says how the buyer confirmed
// the mandate and, when a passkey registered to their account also signed it, holds that signature,
// where and when it was made, and the result of checking it, which anyone can repeat from the item
// alone. For a purchase a shopping agent proposed, the decision item shows what the agent looked at,
// chose and why, and whether the receipt, verified against Behest's public keys, commits to that
// record by its hash. Every claim a check backs is made only once that check has passed.
//
// Text written by others is quoted where the pack writes it, with wrapUntrusted, so the evidence agent
// reads it as data: the gate and intent reasons, which can hold seller-written titles, what a seller
// answered, errors PayPal sent back, and in the decision item seller titles and the shopping agent's
// own words. The buyer's own words are written as they gave them, except
// that any untrusted tag in them is escaped, so they can never look quoted. Nothing in a pack names
// the buyer, their wallet's ids or the seller's payout email: the log drops each such field and blanks
// out any such value it still finds, before it cuts any quote.

export const EVIDENCE_IDS = [
  'mandate',
  'readback',
  'receipt',
  'cart',
  'decision',
  'purchase_log',
  'approval',
  'tracking',
] as const;
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
/** How much of each seller title the decision item keeps, as the shopping agent's tools quote titles. */
const MAX_TITLE_CHARS = 400;

type Purchase = typeof purchases.$inferSelect;
type Mandate = typeof mandates.$inferSelect;
type Receipt = typeof receipts.$inferSelect;
type PurchaseEvent = { kind: string; data: Record<string, unknown>; createdAt: Date };

/**
 * The evidence pack for the dispute whose row id is `disputeId`, with the receipt verification link
 * built on `appOrigin`, Behest's public origin. Behest's signatures on the mandate and the receipt are
 * checked against `jwks`, its public key set, before the pack relies on them. The receipt item is
 * left out for a purchase that was never given one, and the approval item is there only for a
 * purchase that needed the buyer's approval. Throws for a dispute that does not exist or is not yet
 * matched to a purchase.
 */
export async function assembleEvidencePack(
  db: Db,
  disputeId: string,
  appOrigin: string,
  jwks: { keys: JWK[] },
): Promise<EvidencePack> {
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

  // Only a passkey mandate's item relies on Behest's signature, which binds the passkey to the buyer.
  const passkey =
    mandate.confirmation === 'passkey'
      ? {
          check: await verifyMandatePasskey(mandate),
          behestSigned: await verifies(mandate.jws, 'behest-mandate+jws', jwks, MandatePayload),
        }
      : null;
  const items: EvidenceItem[] = [
    { id: 'mandate', title: 'Signed mandate', body: mandateBody(mandate, passkey) },
    { id: 'readback', title: 'Readback the buyer confirmed', body: readbackBody(mandate) },
  ];
  if (receipt) items.push({ id: 'receipt', title: 'Signed receipt', body: receiptBody(receipt, verifyUrl) });
  items.push({ id: 'cart', title: 'Cart', body: cartBody(purchase.cart) });
  if (purchase.decisionRecord) {
    // The receipt hashed the record as stored, so the hash is of that, whether or not it parses.
    const hash = hashOf(purchase.decisionRecord);
    const parsed = DecisionRecord.safeParse(purchase.decisionRecord);
    const record = parsed.success ? parsed.data : null;
    const titles = record ? await currentTitles(db, record) : new Map<string, string>();
    const commitment = await receiptCommitment(hash, receipt, jwks);
    items.push({ id: 'decision', title: "The agent's decision", body: decisionBody(record, hash, titles, commitment) });
  }
  const privateValues = [purchase.buyerId, wallet?.paymentTokenId, wallet?.setupTokenId, wallet?.customerId, payoutEmail];
  items.push({ id: 'purchase_log', title: 'Purchase log', body: logBody(purchase, events, privateValues) });
  if (purchase.finalVerdict === 'ASK' || purchase.approver === 'human') {
    items.push({ id: 'approval', title: "The buyer's approval", body: approvalBody(purchase, events) });
  }
  return { disputeId, purchaseId, items };
}

/** Whether `jws` is a JWS of type `typ` that verifies against `jwks` and parses as `schema`. */
async function verifies<T>(jws: string, typ: JwsType, jwks: { keys: JWK[] }, schema: z.ZodType<T>): Promise<boolean> {
  try {
    await verifyJws(jws, typ, jwks, schema);
    return true;
  } catch {
    return false;
  }
}

/** The result of checking a passkey signature, as the mandate item states it. */
function passkeyCheckLine(check: PasskeyCheck): string {
  if (check.verified) {
    return check.userVerified
      ? 'Passkey signature check: verified, with the user present and verified by the authenticator.'
      : 'Passkey signature check: verified, with the user present. The authenticator did not report verifying the user.';
  }
  switch (check.reason) {
    case 'origin_unknown':
      return 'Passkey signature check: not made, because the origin and RP id the signature was made for were not recorded with it.';
    case 'session':
      return 'Passkey signature check: not made, because no passkey signed this mandate.';
    case 'malformed':
      return 'Passkey signature check: failed, because the signed mandate or the stored signature could not be read.';
    case 'hash_mismatch':
      return 'Passkey signature check: failed, because the stored policy or readback does not hash to what the signed mandate carries.';
    case 'outside_window':
      return "Passkey signature check: failed, because the signed mandate's confirmation time is outside the signing window, so the signature does not vouch for it.";
    case 'bad_signature':
      return 'Passkey signature check: failed, because the signature does not verify against the passkey the signed mandate names, at the recorded origin and RP id.';
  }
}

function mandateBody(mandate: Mandate, passkey: { check: PasskeyCheck; behestSigned: boolean } | null): string {
  return [
    `Mandate ${mandate.id}, signed by Behest when the buyer confirmed it at ${mandate.confirmedAt.toISOString()}.`,
    `Expires: ${mandate.expiresAt?.toISOString() ?? 'never'}.`,
    `Policy hash: ${mandate.policyHash}`,
    passkey
      ? "Confirmed by: the buyer's signed-in session, with a signature over this mandate's policy and readback hashes from a passkey registered to the buyer's Behest account."
      : "Confirmed by: the buyer's signed-in session alone. No passkey signed this mandate, so Behest's is the only signature on it.",
    '',
    "The mandate in the buyer's own words:",
    unquotable(mandate.sourceText),
    '',
    'The signed mandate, a compact JWS:',
    mandate.jws,
    ...(passkey ? ['', ...passkeyLines(mandate, passkey.check, passkey.behestSigned)] : []),
  ].join('\n');
}

/**
 * The passkey signature over a mandate, every field of it base64url, a number, a time, or the origin
 * and RP id it was made for, so nothing in it can pass for words; with how to check it and the results
 * of checking it and Behest's signature on the mandate.
 */
function passkeyLines(mandate: Mandate, check: PasskeyCheck, behestSigned: boolean): string[] {
  const payload = signedMandate(mandate.jws);
  const passkey = payload?.confirmation === 'passkey' ? payload.passkey : null;
  const assertion = mandate.buyerAssertion;
  const window =
    assertion && payload
      ? `Signing window: from ${new Date((assertion.exp - TICKET_SECONDS) * 1000).toISOString()} until ${new Date(assertion.exp * 1000).toISOString()}. The signed mandate's confirmation time, ${payload.confirmedAt}, must fall in it.`
      : 'Signing window: not recorded.';
  const rpID = assertion?.rpID ?? 'not recorded';
  const origin = assertion?.origin ?? 'not recorded';
  return [
    'The passkey signature:',
    `Credential id: ${assertion?.credentialId ?? 'not recorded'}`,
    `Public key (COSE, base64url): ${passkey?.publicKey ?? 'not in the signed mandate'}`,
    `Algorithm (COSE): ${passkey?.alg ?? 'not in the signed mandate'}`,
    `Authenticator data (base64url): ${assertion?.authenticatorData ?? 'not recorded'}`,
    `Client data JSON (base64url): ${assertion?.clientDataJSON ?? 'not recorded'}`,
    `Signature (base64url): ${assertion?.signature ?? 'not recorded'}`,
    `Challenge (base64url): ${assertion?.challenge ?? 'not recorded'}`,
    `Nonce: ${assertion?.nonce ?? 'not recorded'}`,
    `Expiry (exp): ${assertion?.exp ?? 'not recorded'}`,
    window,
    `Origin: ${origin}`,
    `RP id: ${rpID}`,
    `How to check it: compute the challenge, the SHA-256, base64url, of the canonical JSON (RFC 8785) of { policyHash, readbackHash, nonce, exp } with the hashes the signed mandate carries, then verify the WebAuthn assertion over it for RP id ${rpID} at origin ${origin} with the public key above, which the signed mandate names.`,
    behestSigned
      ? "Behest's signature on the mandate JWS, which binds that public key to the buyer's account: verified against Behest's public keys."
      : "Behest's signature on the mandate JWS, which binds that public key to the buyer's account: does not verify against Behest's public keys.",
    passkeyCheckLine(check),
  ];
}

/** The signed mandate's payload, read without checking Behest's signature, or null when it cannot be read. */
function signedMandate(jws: string): MandatePayload | null {
  try {
    const parsed = MandatePayload.safeParse(decodeJwt(jws));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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

/** Text the shopping agent wrote, quoted, so that it reads as the agent's words and never as Behest's. */
function agentQuote(text: string): string {
  return wrapUntrusted('shopping_agent', text, MAX_QUOTED_CHARS);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * The titles the listings in a decision record have now, by seller slug and SKU. A record keeps only
 * each title's hash, so the item can show a title only where the listing still has it.
 */
async function currentTitles(db: Db, record: DecisionRecord): Promise<Map<string, string>> {
  const listings = record.steps.flatMap(listingsOf);
  if (listings.length === 0) return new Map();
  const rows = await db
    .select({ sellerSlug: sellers.slug, sku: products.sku, title: products.title })
    .from(products)
    .innerJoin(sellers, eq(sellers.id, products.sellerId))
    .where(
      and(
        inArray(sellers.slug, [...new Set(listings.map((listing) => listing.sellerSlug))]),
        inArray(products.sku, [...new Set(listings.map((listing) => listing.sku))]),
      ),
    );
  return new Map(rows.map((row) => [listingKey(row), row.title]));
}

function listingsOf(step: DecisionStep): DecisionListing[] {
  if (step.tool === 'search_sellers') return step.listings;
  if (step.tool === 'get_product' && step.listing) return [step.listing];
  return [];
}

const listingKey = ({ sellerSlug, sku }: { sellerSlug: string; sku: string }) => JSON.stringify([sellerSlug, sku]);

/**
 * What the shopping agent looked at, chose and why, from the purchase's decision record (null when
 * the stored record does not parse), then the record's `hash` and whether the signed receipt commits
 * to it. Seller titles are quoted where the listing still has the title the record hashed; the
 * agent's searches, choice and rationale are quoted as its own words. Prices, stock, SKUs and slugs
 * are the tools' answers, written plainly.
 */
function decisionBody(record: DecisionRecord | null, hash: string, titles: Map<string, string>, commitment: string): string {
  const listingLine = (listing: DecisionListing) => {
    const stock = listing.stock === null ? 'stock not tracked' : `${listing.stock} in stock`;
    const title = titles.get(listingKey(listing));
    const shown =
      title !== undefined && sha256Hex(title) === listing.titleHash
        ? wrapUntrusted('seller_listing', title, MAX_TITLE_CHARS)
        : `title hash ${listing.titleHash}, which the listing no longer has`;
    return `   - ${listing.sellerSlug} ${listing.sku} at ${formatUsd(listing.priceCents)}, ${stock}: ${shown}`;
  };
  const price = (cents: number | null) => (cents === null ? 'unknown' : formatUsd(cents));
  const stepLines = (step: DecisionStep, index: number): string[] => {
    const n = `${index + 1}.`;
    switch (step.tool) {
      case 'search_sellers': {
        const { query, category, maxPriceCents } = step.input;
        const inCategory = category ? `, in ${category}` : '';
        const atMost = maxPriceCents === undefined ? '' : `, at most ${formatUsd(maxPriceCents)}`;
        const found = plural(step.listings.length, 'listing', 'listings');
        return [
          `${n} Searched Behest sellers for ${agentQuote(query)}${inCategory}${atMost}: ${found}.`,
          ...step.listings.map(listingLine),
        ];
      }
      case 'search_market': {
        if (step.results === null) {
          return [`${n} Looked up market prices for ${agentQuote(step.input.query)}: market prices were not available.`];
        }
        const found = plural(step.results.length, 'result', 'results');
        return [
          `${n} Looked up market prices for ${agentQuote(step.input.query)}: ${found}.`,
          ...step.results.map(
            (result) =>
              `   - median ${price(result.medianPriceCents)}, cheapest ${price(result.cheapestCents)}, title hash ${result.titleHash}`,
          ),
        ];
      }
      case 'get_product': {
        const asked = agentQuote(`${step.input.sellerSlug} ${step.input.sku}`);
        return step.listing
          ? [`${n} Looked up the listing ${asked}:`, listingLine(step.listing)]
          : [`${n} Looked up the listing ${asked}: there was no such listing to buy.`];
      }
    }
  };
  const lines = record
    ? [
        `What the shopping agent looked at, chose and why before it proposed this purchase, in agent run ${record.runId}, as Behest recorded it while the agent's tools answered.`,
        'Titles sellers and the market wrote are recorded only as SHA-256 hashes. A title is shown, quoted, where the listing still has the title with the recorded hash.',
        '',
        'What it looked at, in order:',
        ...(record.steps.length > 0 ? record.steps.flatMap(stepLines) : ['- Nothing: it proposed without searching.']),
        '',
        `What it chose: ${agentQuote(`${record.choice.items.map((item) => `${item.quantity} x ${item.sku}`).join(' and ')} from ${record.choice.sellerSlug}`)}`,
        `Why, in the agent's words: ${agentQuote(record.rationale)}`,
      ]
    : ['The decision record is stored, but it could not be read.'];
  return [...lines, '', `Decision record hash: ${hash}`, commitment].join('\n');
}

/**
 * Whether the purchase's receipt commits to the decision record with hash `hash`. The receipt counts
 * only once it verifies against `jwks`, Behest's public keys: a stored receipt alone proves nothing.
 */
async function receiptCommitment(hash: string, receipt: Receipt | null, jwks: { keys: JWK[] }): Promise<string> {
  if (!receipt) return 'The purchase has no signed receipt to commit to this record.';
  let payload: ReceiptPayload;
  try {
    payload = await verifyJws(receipt.jws, 'behest-receipt+jws', jwks, ReceiptPayload);
  } catch {
    return "The stored receipt does not verify against Behest's public keys, so it is not counted as committing to this record.";
  }
  const verified = "The signed receipt, verified against Behest's public keys,";
  const claimed = payload.agent?.decisionHash;
  if (claimed === undefined) return `${verified} carries no decision hash, so it does not commit to this record.`;
  if (claimed !== hash) return `${verified} carries ${claimed} as agent.decisionHash, which does not match this record.`;
  return `${verified} carries this hash as agent.decisionHash, so this is the record Behest signed for.`;
}

/** `text` with the less-than sign of every untrusted tag in it escaped, as wrapUntrusted escapes it, so it cannot pass for a quote. */
function unquotable(text: string): string {
  return text.replace(/<(?=\/?untrusted)/gi, '\\u003c');
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
  // Every event's private fields are gathered before any line is written, since a value one event
  // holds privately can turn up in another event's text.
  const shown = events.map((event) => publicFields(event.data, hidden));
  // Longest first, so a value that contains another is blanked out whole.
  const ordered = [...hidden].sort((a, b) => b.length - a.length);
  const redact = (text: string) => ordered.reduce((out, value) => out.replaceAll(value, REDACTED), text);

  const steps = events.map((event, index) => {
    const data = shown[index];
    const quoted: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      const source = quoteSource(event.kind, field);
      if (!source || typeof value !== 'string') continue;
      delete data[field];
      // Blanked out before the quote is cut, or a value straddling the cut would leave its start behind.
      // Hidden characters go first, since the quote drops them and would otherwise rejoin a split value.
      quoted.push(` ${field}: ${wrapUntrusted(source, redact(removeHiddenCharacters(value)), MAX_QUOTED_CHARS)}`);
    }
    const fields = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
    return `${index + 1}. ${event.createdAt.toISOString()} ${event.kind}${fields}${quoted.join('')}`;
  });
  const payment = purchase.paypalCaptureId
    ? `PayPal order ${purchase.paypalOrderId}, capture ${purchase.paypalCaptureId}, captured at ${purchase.capturedAt?.toISOString() ?? 'an unrecorded time'}.`
    : 'No PayPal capture is recorded.';
  const text = [
    `Purchase ${purchase.id}, created at ${purchase.createdAt.toISOString()}.`,
    `The buyer's request to the agent: ${unquotable(purchase.request)}`,
    `Gate verdict: ${purchase.gateVerdict} under ruleset ${purchase.rulesetVersion}. Final verdict: ${purchase.finalVerdict ?? 'none'}, approved by ${approverText(purchase.approver)}.`,
    payment,
    `Status now: ${purchase.status}.`,
    '',
    'Every recorded step, in order:',
    ...steps,
  ].join('\n');
  // Again over the whole log, in case a private value turns up anywhere else.
  return redact(text);
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
