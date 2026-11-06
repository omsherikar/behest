import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Category } from '../domain/categories';
import type { MandatePolicy } from '../domain/policy';

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
