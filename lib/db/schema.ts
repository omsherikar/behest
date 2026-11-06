import {
  bigint,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Cart } from '../domain/cart';
import type { Category } from '../domain/categories';
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
export const walletStatus = pgEnum('wallet_status', ['pending', 'linked', 'revoked']);

export const buyers = pgTable('buyers', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

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

/** A signed spending mandate. The policy is what the gate enforces; the readback is what the buyer confirmed. */
export const mandates = pgTable('mandates', {
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
  status: mandateStatus('status').notNull().default('active'),
  /** When the buyer confirmed; the start of a `once` budget period. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
export const approver = pgEnum('approver', ['policy', 'human']);

/** One gate rule's result as stored on a purchase. */
export type StoredRuleOutcome = { rule: string; result: 'pass' | 'ask' | 'block' | 'skip'; detail: string };
/** The intent check's result as stored on a purchase. */
export type StoredIntentResult = {
  verdict: 'consistent' | 'needs_human' | 'inconsistent' | 'unavailable';
  reasons: string[];
};

export const purchases = pgTable('purchases', {
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
  paypalOrderId: text('paypal_order_id'),
  paypalCaptureId: text('paypal_capture_id'),
  /** The PayPal link the buyer opens to approve an ASK purchase. */
  approveUrl: text('approve_url'),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Append-only log of a purchase's transitions and agent steps. Rows are never updated or deleted. */
export const purchaseEvents = pgTable('purchase_events', {
  id: id(),
  /** Insertion order. Timestamps alone can tie inside one transaction. */
  seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  purchaseId: uuid('purchase_id')
    .notNull()
    .references(() => purchases.id),
  kind: text('kind').notNull(),
  data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});
