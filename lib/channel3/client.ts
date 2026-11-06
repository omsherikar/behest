import { z } from 'zod';
import { oneLine } from '@/lib/catalog/csv';

// Channel3 product search, for open-web price benchmarks: what a product sells for at other
// retailers. Plain fetch, no SDK. Server-side only: it reads the API key from the environment.
// Titles, brands, domains and links come from third parties. They stay plain data here; whoever
// shows them to a model quotes them as untrusted text.

const SEARCH_URL = 'https://api.trychannel3.com/v1/search';
const DEFAULT_LIMIT = 5;
const TITLE_MAX = 120;
/** Retries after a 429 before it surfaces as an error. No other status is retried. */
const MAX_RETRIES = 2;
/** The wait before a retry when Retry-After gives no number of seconds. */
const DEFAULT_WAIT_MS = 1000;
/** The longest wait before a retry, whatever Retry-After asks for. */
const MAX_WAIT_MS = 5000;
/** The largest value of a Postgres integer, the column type the benchmark is stored in. */
const INT_MAX = 2_147_483_647;

export type MarketOffer = { domain: string; priceCents: number; availability: string; url: string };

export type MarketProduct = {
  id: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  /** The product's offers priced in USD, in the order Channel3 lists them. */
  offers: MarketOffer[];
  /** The median of the offers' prices, or null when there are no offers. */
  medianPriceCents: number | null;
};

export class Channel3ApiError extends Error {
  constructor(
    readonly status: number,
    /** The full response body. The message keeps only its start. */
    readonly body: string,
  ) {
    super(`Channel3 ${status} on /v1/search: ${body.slice(0, 300)}`);
    this.name = 'Channel3ApiError';
  }
}

// Only the fields used are read. Products and offers are checked one at a time, so one malformed
// item is dropped without losing the rest of the results.
const SearchResponse = z.object({ products: z.array(z.unknown()) });
const Product = z.object({
  id: z.string(),
  title: z.string(),
  brands: z.array(z.unknown()).nullish(),
  images: z.array(z.unknown()).nullish(),
  offers: z.array(z.unknown()).nullish(),
});
const Brand = z.object({ name: z.string() });
const Image = z.object({ url: z.string(), cleaned_url: z.string().nullish(), is_main_image: z.boolean().nullish() });
const Offer = z.object({
  url: z.string(),
  domain: z.string(),
  price: z.object({ price: z.number(), currency: z.string() }),
  availability: z.string(),
});

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Products on the open web matching `query`, with in-stock offers only, at most `limit` (default 5).
 * A 429 is retried twice, waiting as Retry-After asks up to 5 seconds, then surfaces as a
 * `Channel3ApiError`, as does any other status outside 2xx at once. Network errors propagate.
 * Throws before any request when CHANNEL3_API_KEY is not set.
 */
export async function searchMarket(
  query: string,
  opts: { limit?: number; fetch?: typeof fetch } = {},
): Promise<MarketProduct[]> {
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) throw new Error('CHANNEL3_API_KEY must be set to search Channel3 (see .env.example)');
  const send = opts.fetch ?? fetch;
  const body = JSON.stringify({ query, limit: opts.limit ?? DEFAULT_LIMIT, filters: { availability: ['InStock'] } });

  for (let retries = 0; ; retries++) {
    const res = await send(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body,
      cache: 'no-store',
    });
    if (res.ok) return marketProducts(await res.json());

    const text = await res.text();
    if (res.status === 429 && retries < MAX_RETRIES) {
      await sleep(retryWait(res.headers.get('retry-after')));
      continue;
    }
    throw new Channel3ApiError(res.status, text);
  }
}

function marketProducts(json: unknown): MarketProduct[] {
  const response = SearchResponse.safeParse(json);
  if (!response.success) throw new Error('Channel3 sent an unexpected search response: it has no product list');
  return valid(Product, response.data.products).map((product) => {
    const offers = valid(Offer, product.offers ?? []).flatMap(usdOffer);
    return {
      id: product.id,
      title: oneLine(product.title, TITLE_MAX),
      brand: valid(Brand, product.brands ?? [])[0]?.name ?? null,
      imageUrl: imageUrl(valid(Image, product.images ?? [])),
      offers,
      medianPriceCents: median(offers.map((offer) => offer.priceCents)),
    };
  });
}

/** The items that match `schema`, read as it reads them. */
function valid<T>(schema: z.ZodType<T>, items: unknown[]): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The offer in cents when it is priced in USD at a storable whole number of cents and linked over http. */
function usdOffer(offer: z.infer<typeof Offer>): MarketOffer[] {
  const priceCents = Math.round(offer.price.price * 100);
  const url = webUrl(offer.url);
  if (offer.price.currency !== 'USD' || priceCents < 1 || priceCents > INT_MAX || url === null) return [];
  return [{ domain: offer.domain, priceCents, availability: offer.availability, url }];
}

/** The main image, or else the first, preferring the background-removed copy Channel3 hosts. */
function imageUrl(images: z.infer<typeof Image>[]): string | null {
  const image = images.find((i) => i.is_main_image) ?? images[0];
  if (image === undefined) return null;
  return webUrl(image.cleaned_url) ?? webUrl(image.url);
}

/** `text` when it is an http or https URL, otherwise null. */
function webUrl(text: string | null | undefined): string | null {
  if (!text || !URL.canParse(text)) return null;
  const { protocol } = new URL(text);
  return protocol === 'https:' || protocol === 'http:' ? text : null;
}

/** The middle value, or with an even count the mean of the middle two rounded down to a whole cent. */
function median(cents: number[]): number | null {
  if (cents.length === 0) return null;
  const sorted = [...cents].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The wait Retry-After asks for in seconds, at most `MAX_WAIT_MS`, or `DEFAULT_WAIT_MS` when it gives no number. */
function retryWait(retryAfter: string | null): number {
  const seconds = retryAfter === null || retryAfter.trim() === '' ? Number.NaN : Number(retryAfter);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_WAIT_MS;
  return Math.min(seconds * 1000, MAX_WAIT_MS);
}

/** For tests: replace the wait between retries, so tests neither sleep nor depend on timers. */
export function setChannel3RetrySleepForTests(wait: (ms: number) => Promise<void>): void {
  sleep = wait;
}
