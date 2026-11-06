import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { and, arrayContains, asc, eq, gt, ilike, isNull, lte, not, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { products, sellers } from '@/lib/db/schema';
import { CATEGORIES } from '@/lib/domain/categories';
import { PurchaseProposal } from '@/lib/domain/proposal';
import type { ProposalOutcome } from '@/lib/purchases/deps';
import { quoteUntrusted } from './quote';

// The shopping agent's four tools. The agent finds products at Behest sellers, compares market prices
// and proposes purchases, but it never sets a price: a proposal names a seller, SKUs and quantities,
// and the purchase flow prices the cart from the catalog. Every string a seller or the market wrote
// reaches the model quoted as untrusted data. Prices, stock, SKUs and slugs are plain fields.

/** Market prices for a search, from Channel3. */
export type MarketSearch = (
  query: string,
) => Promise<{ title: string; medianPriceCents: number | null; offers: { priceCents: number }[] }[]>;

export type ShoppingToolsContext = {
  db: Db;
  /** The buyer the agent shops for. */
  buyerId: string;
  /** The agent run the tools serve. */
  runId: string;
  /** What the buyer asked for, in their own words. */
  request: string;
  /** Runs a proposal through the gate and the purchase flow. */
  propose: (proposal: PurchaseProposal) => Promise<ProposalOutcome>;
  /** Without it, the agent is told that market prices are not available. */
  search?: MarketSearch;
};

const SELLER_RESULTS = 10;
const MARKET_RESULTS = 5;
/**
 * The catalog keeps descriptions to 2000 characters. Quoting escapes each less-than sign into six
 * characters, so a description holding some may still be cut, with `...` marking the cut.
 */
const DESCRIPTION_MAX = 2000;
/** The largest value of a Postgres integer, the column type of price. */
const INT_MAX = 2_147_483_647;
/** The screening flag on listings that speak to AI agents. Agents never see them. */
const AGENT_INSTRUCTIONS = 'agent_instructions';

export const MARKET_NOTE = 'For price comparison only. These cannot be purchased.';
const MARKET_UNAVAILABLE = 'Market prices are not available right now.';
const PRODUCT_NOT_FOUND = 'No listing with that SKU at that seller. Use search_sellers to find one.';

const SearchSellersInput = z
  .object({
    query: z
      .string()
      .max(200)
      .describe('Words to find in product titles and descriptions, such as "turmeric". An empty query matches every product.'),
    category: z.enum(CATEGORIES).describe('Only products in this category.').optional(),
    maxPriceCents: z
      .number()
      .int()
      .positive()
      .max(INT_MAX)
      .describe('Only products whose unit price is at most this many US cents.')
      .optional(),
  })
  .strict();

const SearchMarketInput = z
  .object({ query: z.string().min(1).max(200).describe('The product to price, such as "turmeric powder 100g".') })
  .strict();

const GetProductInput = z
  .object({
    sellerSlug: z.string().min(1).describe('The sellerSlug from search_sellers.'),
    sku: z.string().min(1).describe('The sku from search_sellers.'),
  })
  .strict();

// The proposal's own fields and limits, so a proposal the tool accepts is one the gate can read.
const ProposePurchaseInput = z
  .object({
    sellerSlug: PurchaseProposal.shape.sellerSlug.describe('The one seller to buy from, as its sellerSlug.'),
    items: PurchaseProposal.shape.items.describe(
      'What to buy from that seller: each SKU once, with how many units of it, from 1 to 99.',
    ),
    rationale: PurchaseProposal.shape.rationale.describe(
      "One or two sentences on how this cart matches the buyer's request. The buyer may read it.",
    ),
  })
  .strict();

/** `query` as an ILIKE pattern matching it anywhere, with its wildcards and escape character matched literally. */
function containsPattern(query: string): string {
  return `%${query.replaceAll(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Listings that screening did not flag as speaking to AI agents. */
const unflagged = () => not(arrayContains(products.flags, [AGENT_INSTRUCTIONS]));

/** The shopping agent's tools: search_sellers, search_market, get_product and propose_purchase. */
export function buildShoppingTools(ctx: ShoppingToolsContext): BetaRunnableTool<any>[] { // eslint-disable-line @typescript-eslint/no-explicit-any -- each tool has its own input type
  // The tool loop sends each schema in the form strict mode accepts; parse still checks all of it.
  const searchSellers = betaZodTool({
    name: 'search_sellers',
    description:
      'Search the products that Behest sellers list. Only these can be bought. Returns up to 10 in-stock listings, cheapest first, each with its seller, SKU, title, category, unit price in US cents, units in stock (null when the seller does not track stock) and the market median unit price in US cents when known.',
    inputSchema: SearchSellersInput,
    strict: true,
    run: async ({ query, category, maxPriceCents }) => {
      const pattern = containsPattern(query.trim());
      const rows = await ctx.db
        .select({
          sellerSlug: sellers.slug,
          sellerName: sellers.name,
          sku: products.sku,
          title: products.title,
          category: products.category,
          priceCents: products.priceCents,
          stock: products.stock,
          marketMedianCents: products.marketMedianCents,
        })
        .from(products)
        .innerJoin(sellers, eq(products.sellerId, sellers.id))
        .where(
          and(
            or(ilike(products.title, pattern), ilike(products.description, pattern)),
            category === undefined ? undefined : eq(products.category, category),
            maxPriceCents === undefined ? undefined : lte(products.priceCents, maxPriceCents),
            or(isNull(products.stock), gt(products.stock, 0)),
            unflagged(),
          ),
        )
        .orderBy(asc(products.priceCents), asc(sellers.slug), asc(products.sku))
        .limit(SELLER_RESULTS);
      return JSON.stringify(
        rows.map((row) => ({
          ...row,
          sellerName: quoteUntrusted('seller_listing', row.sellerName),
          title: quoteUntrusted('seller_listing', row.title),
        })),
      );
    },
  });

  const searchMarket = betaZodTool({
    name: 'search_market',
    description:
      'Look up what a product costs elsewhere on the web, to judge whether a Behest price is fair. These products cannot be bought. Returns up to 5 results, each with a title, the median price and the cheapest offer in US cents.',
    inputSchema: SearchMarketInput,
    strict: true,
    run: async ({ query }) => {
      if (!ctx.search) return MARKET_UNAVAILABLE;
      let results: Awaited<ReturnType<MarketSearch>>;
      try {
        results = await ctx.search(query);
      } catch {
        // The error may carry text from the market's response, which must not reach the model unquoted.
        return MARKET_UNAVAILABLE;
      }
      return JSON.stringify({
        note: MARKET_NOTE,
        results: results.slice(0, MARKET_RESULTS).map((result) => ({
          title: quoteUntrusted('market', result.title),
          medianPriceCents: result.medianPriceCents,
          cheapestCents: result.offers.length > 0 ? Math.min(...result.offers.map((offer) => offer.priceCents)) : null,
        })),
      });
    },
  });

  const getProduct = betaZodTool({
    name: 'get_product',
    description:
      "Show one listing at a Behest seller in full: everything search_sellers returns, plus the seller's description of the product.",
    inputSchema: GetProductInput,
    strict: true,
    run: async ({ sellerSlug, sku }) => {
      const [row] = await ctx.db
        .select({
          sellerSlug: sellers.slug,
          sellerName: sellers.name,
          sku: products.sku,
          title: products.title,
          description: products.description,
          category: products.category,
          priceCents: products.priceCents,
          stock: products.stock,
          marketMedianCents: products.marketMedianCents,
        })
        .from(products)
        .innerJoin(sellers, eq(products.sellerId, sellers.id))
        .where(and(eq(sellers.slug, sellerSlug), eq(products.sku, sku), unflagged()));
      if (!row) return PRODUCT_NOT_FOUND;
      return JSON.stringify({
        ...row,
        sellerName: quoteUntrusted('seller_listing', row.sellerName),
        title: quoteUntrusted('seller_listing', row.title),
        description: quoteUntrusted('seller_listing', row.description, DESCRIPTION_MAX),
      });
    },
  });

  const proposePurchase = betaZodTool({
    name: 'propose_purchase',
    description:
      "Ask Behest to buy items from one seller. Behest prices the cart from its own catalog, checks it against the buyer's mandate and request, and returns its decision as JSON: verdict ALLOW (paid), ASK (waiting for the buyer to approve it at PayPal) or BLOCK (not bought), with the reasons.",
    inputSchema: ProposePurchaseInput,
    strict: true,
    run: async ({ sellerSlug, items, rationale }) => {
      const outcome = await ctx.propose({
        sellerSlug,
        items: items.map(({ sku, quantity }) => ({ sku, quantity })),
        rationale,
      });
      // Gate reasons repeat seller titles and names, and intent reasons are the check model's own words.
      return JSON.stringify({
        ...outcome,
        reasons: outcome.reasons.map((reason) => quoteUntrusted('seller_listing', reason, 400)),
      });
    },
  });

  return [searchSellers, searchMarket, getProduct, proposePurchase];
}
