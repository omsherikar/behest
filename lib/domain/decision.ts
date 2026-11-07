import { z } from 'zod';
import { CATEGORIES } from './categories';
import { PurchaseProposal } from './proposal';

// What the shopping agent looked at, what it chose and why, recorded as its tools answered and
// snapshotted when it proposed a purchase. The purchase keeps the record and its signed receipt
// carries the record's hash, so the record can be shown to be the one Behest signed for. Text
// sellers or the market wrote is never kept: each title is recorded as its SHA-256, which anyone
// can check against the listing without the record holding untrusted text. The tool inputs, the
// choice and the rationale are the agent's own words.

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const cents = z.number().int();

/** A listing at a Behest seller as a tool showed it to the agent. */
const Listing = z
  .object({
    sellerSlug: z.string(),
    sku: z.string(),
    priceCents: cents,
    /** Units in stock; null when the seller does not track stock. */
    stock: z.number().int().nullable(),
    /** SHA-256 hex of the listing's title, as the seller wrote it. */
    titleHash: sha256Hex,
  })
  .strict();
export type DecisionListing = z.infer<typeof Listing>;

/** A market price the agent compared against. */
const MarketResult = z
  .object({
    /** SHA-256 hex of the result's title, as the market wrote it. */
    titleHash: sha256Hex,
    medianPriceCents: cents.nullable(),
    cheapestCents: cents.nullable(),
  })
  .strict();

/** One tool call the agent made, with what it asked and a compact summary of the answer. */
export const DecisionStep = z.discriminatedUnion('tool', [
  z
    .object({
      tool: z.literal('search_sellers'),
      input: z
        .object({ query: z.string(), category: z.enum(CATEGORIES).optional(), maxPriceCents: cents.optional() })
        .strict(),
      listings: z.array(Listing),
    })
    .strict(),
  z
    .object({
      tool: z.literal('search_market'),
      input: z.object({ query: z.string() }).strict(),
      /** Null when market prices were not available. */
      results: z.array(MarketResult).nullable(),
    })
    .strict(),
  z
    .object({
      tool: z.literal('get_product'),
      input: z.object({ sellerSlug: z.string(), sku: z.string() }).strict(),
      /** Null when there was no such listing to buy. */
      listing: Listing.nullable(),
    })
    .strict(),
]);
export type DecisionStep = z.infer<typeof DecisionStep>;

export const DecisionRecord = z
  .object({
    v: z.literal(1),
    /** The shopping agent run that proposed the purchase. */
    runId: z.string().min(1),
    /** Every search and lookup the agent made in the run before it proposed, in order. */
    steps: z.array(DecisionStep),
    /** What the agent proposed to buy: one seller, and SKUs with quantities. */
    choice: PurchaseProposal.pick({ sellerSlug: true, items: true }),
    /** The agent's own account of why, unverified. */
    rationale: PurchaseProposal.shape.rationale,
  })
  .strict();
export type DecisionRecord = z.infer<typeof DecisionRecord>;
