import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Cart } from '../domain/cart';
import type { Category } from '../domain/categories';
import type { BuyerAssertion } from '../domain/passkey';
import type { MandatePolicy } from '../domain/policy';
import type { PurchaseProposal } from '../domain/proposal';

// The database schema. Money is integer cents with an ISO currency code (USD only), and every
// timestamp is stored with its time zone so it reads back as an exact instant.

const id = () => uuid('id').defaultRandom().primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const currency = () => text('currency').$type<'USD'>().notNull().default('USD');

// Buyers, wallets and mandates

export const mandateStatus = pgEnum('mandate_status', ['active', 'revoked', 'expired']);
/** How the buyer confirmed a mandate: by a signed-in session alone, or by also signing its hashes with a passkey. */
export const mandateConfirmation = pgEnum('mandate_confirmation', ['session', 'passkey']);
export type MandateStatus = (typeof mandateStatus.enumValues)[number];
export const walletStatus = pgEnum('wallet_status', ['pending', 'linked', 'revoked']);
export type WalletStatus = (typeof walletStatus.enumValues)[number];

export const buyers = pgTable('buyers', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

/**
 * A buyer's passkey (a WebAuthn credential). The buyer's device holds the private key; Behest keeps
 * the public key so anyone can check that the buyer, not Behest, signed a mandate.
 */
export const buyerPasskeys = pgTable(
  'buyer_passkeys',
  {
    id: id(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    /** The credential id, base64url, as the authenticator reports it. */
    credentialId: text('credential_id').notNull().unique(),
    /** The COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    /** The signature counter last seen; a counter that goes backwards suggests a cloned authenticator. */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('buyer_passkeys_buyer_idx').on(t.buyerId)],
);

/** A buyer's saved PayPal wallet. A buyer has at most one; linking again replaces it. */
export const wallets = pgTable('wallets', {
  id: id(),
  buyerId: uuid('buyer_id')
    .notNull()
    .unique()
    .references(() => buyers.id),
  status: walletStatus('status').notNull().default('pending'),
  /** The vault setup token the buyer approves at PayPal; exchanged for the payment token. */
  setupTokenId: text('setup_token_id'),
  paypalCustomerId: text('paypal_customer_id'),
  paymentTokenId: text('payment_token_id'),
  linkedAt: timestamp('linked_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * A signed spending mandate. The policy is what the gate enforces; the readback is what the buyer
 * confirmed. A buyer has at most one active mandate, so revoke the old one before inserting the new.
 */
export const mandates = pgTable(
  'mandates',
  {
    id: id(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    /** The buyer's own words, kept verbatim. */
    sourceText: text('source_text').notNull(),
    policy: jsonb('policy').$type<MandatePolicy>().notNull(),
    policyHash: text('policy_hash').notNull(),
    /** The plain-English lines rendered from the policy, in order. */
    readback: jsonb('readback').$type<string[]>().notNull(),
    readbackHash: text('readback_hash').notNull(),
    /** The signed mandate, a compact JWS. */
    jws: text('jws').notNull(),
    confirmation: mandateConfirmation('confirmation').notNull().default('session'),
    /**
     * The buyer's passkey assertion over the mandate's hashes (base64url fields, as WebAuthn returns
     * them), with the nonce and expiry its challenge commits to. Null when the buyer confirmed by
     * session alone.
     */
    buyerAssertion: jsonb('buyer_assertion').$type<BuyerAssertion>(),
    status: mandateStatus('status').notNull().default('active'),
    /** When the buyer confirmed; the start of a `once` budget period. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('mandates_one_active_per_buyer').on(t.buyerId).where(sql`${t.status} = 'active'`)],
);

// Sellers and products

export const sellers = pgTable('sellers', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  payoutEmail: text('payout_email').notNull(),
  createdAt: createdAt(),
});

export const products = pgTable(
  'products',
  {
    id: id(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').$type<Category>().notNull(),
    priceCents: integer('price_cents').notNull(),
    currency: currency(),
    /** Units on hand. Null means the seller does not track stock. */
    stock: integer('stock'),
    /** Listing screening results, such as `agent_instructions`. The gate blocks any flagged item. */
    flags: text('flags').array().notNull().default([]),
    /** The matched Channel3 product, when enrichment found one. */
    channel3Id: text('channel3_id'),
    /** Market median unit price from Channel3, the gate's price benchmark. */
    marketMedianCents: integer('market_median_cents'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('products_seller_sku_unique').on(t.sellerId, t.sku)],
);

// Purchases and purchase events

export const verdict = pgEnum('verdict', ['ALLOW', 'ASK', 'BLOCK']);
export const purchaseStatus = pgEnum('purchase_status', [
  'proposed',
  'blocked',
  'charging',
  'awaiting_approval',
  'cancelled',
  'captured',
  'failed',
  'accepted',
  'refunded',
  'settled',
  'disputed',
  'resolved',
]);
/** The purchase lifecycle, shared by the state machine, the orchestrator and the UI. */
export type PurchaseStatus = (typeof purchaseStatus.enumValues)[number];
export const approver = pgEnum('approver', ['policy', 'human']);

/** One gate rule's result as stored on a purchase. */
export type StoredRuleOutcome = { rule: string; result: 'pass' | 'ask' | 'block' | 'skip'; detail: string };
/** The intent check's result as stored on a purchase. */
export type StoredIntentResult = {
  verdict: 'consistent' | 'needs_human' | 'inconsistent' | 'unavailable';
  reasons: string[];
};

export const purchases = pgTable(
  'purchases',
  {
    id: id(),
    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => mandates.id),
    /** Null only when the proposal named a seller Behest does not know; such a purchase is blocked. */
    sellerId: uuid('seller_id').references(() => sellers.id),
    /** The shopping agent run that proposed this purchase, if any. */
    runId: text('run_id'),
    /** The buyer's request the agent was acting on. */
    request: text('request').notNull(),
    /** The agent's proposal exactly as received: seller slug, SKUs, quantities and its unverified rationale. */
    proposal: jsonb('proposal').$type<PurchaseProposal>().notNull(),
    /**
     * What the agent looked at before proposing: its searches, the options each returned and the
     * option it chose. Its hash goes into the signed receipt. Null for purchases made outside an agent run.
     */
    decisionRecord: jsonb('decision_record').$type<Record<string, unknown>>(),
    /** The canonical cart rebuilt from the catalog. Null when the gate could not build a valid cart. */
    cart: jsonb('cart').$type<Cart>(),
    cartHash: text('cart_hash'),
    totalCents: integer('total_cents'),
    currency: currency(),
    gateVerdict: verdict('gate_verdict').notNull(),
    /** Details of the gate rules that did not pass, in rule order. */
    gateReasons: jsonb('gate_reasons').$type<string[]>().notNull().default([]),
    /** Every gate rule's outcome, in rule order. */
    gateOutcomes: jsonb('gate_outcomes').$type<StoredRuleOutcome[]>().notNull().default([]),
    rulesetVersion: text('ruleset_version').notNull(),
    /** Null when the intent check did not run (the gate blocked). */
    intent: jsonb('intent').$type<StoredIntentResult>(),
    /** The gate verdict after the intent check tightened it. Null until the intent check has run or been skipped. */
    finalVerdict: verdict('final_verdict'),
    /** Who approved the payment: the policy for ALLOW, the buyer for ASK. Null until approved. */
    approver: approver('approver'),
    status: purchaseStatus('status').notNull().default('proposed'),
    paypalOrderId: text('paypal_order_id').unique(),
    paypalCaptureId: text('paypal_capture_id'),
    /** The PayPal link the buyer opens to approve an ASK purchase. */
    approveUrl: text('approve_url'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('purchases_buyer_created_idx').on(t.buyerId, t.createdAt),
    index('purchases_paypal_capture_id_idx').on(t.paypalCaptureId),
  ],
);

/** Append-only log of a purchase's transitions and agent steps. Rows are never updated or deleted. */
export const purchaseEvents = pgTable(
  'purchase_events',
  {
    id: id(),
    /** Insertion order. Timestamps alone can tie inside one transaction. */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    purchaseId: uuid('purchase_id')
      .notNull()
      .references(() => purchases.id),
    kind: text('kind').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('purchase_events_purchase_seq_idx').on(t.purchaseId, t.seq)],
);

// Receipts and seller orders

/** A signed receipt. Its id is the receipt id inside the signed payload. */
export const receipts = pgTable('receipts', {
  id: id(),
  purchaseId: uuid('purchase_id')
    .notNull()
    .unique()
    .references(() => purchases.id),
  /** The signed receipt, a compact JWS. */
  jws: text('jws').notNull(),
  payloadHash: text('payload_hash').notNull(),
  keyId: text('key_id').notNull(),
  createdAt: createdAt(),
});

/**
 * The seller side's record of an agent order and the receipt presented with it. Seller intake works
 * as an outside seller would, from the receipt alone, so `receipt_id` is the id read from the
 * presented receipt and deliberately has no reference to the receipts table.
 */
export const sellerOrders = pgTable(
  'seller_orders',
  {
    id: id(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id),
    /** Null when the presented receipt was too malformed to read an id from. */
    receiptId: text('receipt_id'),
    status: text('status').$type<'accepted' | 'rejected'>().notNull(),
    /** Why the receipt was rejected. Null when accepted. */
    reason: text('reason'),
    /** The cart the seller received with the order. */
    cart: jsonb('cart').$type<Cart>().notNull(),
    /** The receipt exactly as presented. */
    receiptJws: text('receipt_jws').notNull(),
    createdAt: createdAt(),
  },
  // A receipt id is spent only by an accepted order, so a rejected attempt (even a forged one
  // carrying a genuine receipt id) can never block the real order.
  (t) => [
    uniqueIndex('seller_orders_accepted_receipt_unique')
      .on(t.receiptId, t.sellerId)
      .where(sql`${t.status} = 'accepted'`),
  ],
);

// Payouts, refunds and disputes

/** The seller's payout for one purchase. One per purchase, so a repeated payout attempt fails on insert. */
export const payouts = pgTable('payouts', {
  id: id(),
  purchaseId: uuid('purchase_id')
    .notNull()
    .unique()
    .references(() => purchases.id),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => sellers.id),
  amountCents: integer('amount_cents').notNull(),
  currency: currency(),
  /** The idempotency key sent to PayPal: `${purchaseId}:payout`. */
  senderBatchId: text('sender_batch_id').notNull(),
  paypalBatchId: text('paypal_batch_id'),
  paypalItemId: text('paypal_item_id'),
  /** The latest PayPal status, such as PENDING, SUCCESS or RETURNED. */
  status: text('status').notNull().default('PENDING'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const refunds = pgTable('refunds', {
  id: id(),
  purchaseId: uuid('purchase_id')
    .notNull()
    .references(() => purchases.id),
  amountCents: integer('amount_cents').notNull(),
  currency: currency(),
  paypalRefundId: text('paypal_refund_id'),
  /** The latest PayPal status, such as PENDING or COMPLETED. */
  status: text('status').notNull().default('PENDING'),
  /** Why the refund was issued, as sent to the payer. */
  reason: text('reason'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One evidence item in a dispute pack. */
export type StoredEvidenceItem = { id: string; title: string; body: string };
/** A dispute narrative in which every claim cites evidence item ids. */
export type StoredNarrative = { summary: string; claims: { text: string; evidenceIds: string[] }[] };

export const disputes = pgTable('disputes', {
  id: id(),
  paypalDisputeId: text('paypal_dispute_id').notNull().unique(),
  /** Null until the dispute's capture is matched to a purchase. */
  purchaseId: uuid('purchase_id').references(() => purchases.id),
  /** The disputed PayPal capture, used to match the purchase. */
  captureId: text('capture_id'),
  reason: text('reason').notNull(),
  /** The latest PayPal status, such as OPEN or RESOLVED. */
  status: text('status').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: currency(),
  buyerNotes: text('buyer_notes'),
  /** When the buyer opened the dispute at PayPal. */
  openedAt: timestamp('opened_at', { withTimezone: true }),
  evidencePack: jsonb('evidence_pack').$type<{
    disputeId: string;
    purchaseId: string;
    items: StoredEvidenceItem[];
  }>(),
  narrative: jsonb('narrative').$type<StoredNarrative>(),
  /** When the operator submitted the evidence to PayPal. Null until submitted. */
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Webhook events, model call log and jobs

/** Verified PayPal webhook events as received, unique by PayPal's event id so each is processed once. */
export const webhookEvents = pgTable('webhook_events', {
  id: id(),
  eventId: text('event_id').notNull().unique(),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

/** One row per Claude call, with tokens and estimated cost. The daily spend cap sums `cost_usd`. */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: id(),
    route: text('route').notNull(),
    model: text('model').notNull(),
    effort: text('effort').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 10, scale: 6, mode: 'number' }).notNull().default(0),
    stopReason: text('stop_reason'),
    /** Anthropic's request id, for support and log correlation. */
    requestId: text('request_id'),
    latencyMs: integer('latency_ms'),
    ok: boolean('ok').notNull(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('llm_calls_created_at_idx').on(t.createdAt)],
);

export const jobStatus = pgEnum('job_status', ['queued', 'running', 'done', 'dead']);
export type JobStatus = (typeof jobStatus.enumValues)[number];

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus('status').notNull().default('queued'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_status_run_at_idx').on(t.status, t.runAt)],
);
