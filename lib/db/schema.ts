import {
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
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
