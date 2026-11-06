import { z } from 'zod';
import { oneLine } from '@/lib/catalog/csv';

// Channel3 product search, for open-web price benchmarks: what a product sells for at other
// retailers. Plain fetch, no SDK. Server-side only: it reads the API key from the environment.
// Titles, brands, domains and links come from third parties. They stay plain data here; whoever
// shows them to a model quotes them as untrusted text.

const SEARCH_URL = 'https://api.trychannel3.com/v1/search';
const DEFAULT_LIMIT = 5;
const TEXT_MAX = 120;
/** Retries after a 429 before it surfaces as an error. No other status is retried. */
const MAX_RETRIES = 2;
/** How long one request may take, from sending it to reading the whole body. */
const TIMEOUT_MS = 10_000;
/** The wait before a retry when Retry-After gives neither a number of seconds nor a date. */
const DEFAULT_WAIT_MS = 1000;
/** The longest wait before a retry, whatever Retry-After asks for. */
const MAX_WAIT_MS = 5000;
/** The largest value of a Postgres integer, the column type the benchmark is stored in. */
const INT_MAX = 2_147_483_647;
/**
 * What an API key may contain: printable ASCII without spaces. Checked before the key goes into a
 * header, because fetch quotes an invalid header value in the error it throws.
 */
const API_KEY = /^[\x21-\x7e]+$/;
/** A price as decimal text: digits, optionally a point and more digits. No sign, no exponent. */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

export type MarketOffer = { domain: string; priceCents: number; availability: string; url: string };

export type MarketProduct = {
  id: string;
  title: string;
  brand: string | null;
  imageUrl: string | null;
  /** The product's offers that are in stock, new and priced in USD, in the order Channel3 lists them. */
  offers: MarketOffer[];
  /** The median price of the offers, or null when there are none. */
  medianPriceCents: number | null;
};

/** Channel3 could not answer the search: it timed out, failed or sent something unreadable. */
export class Channel3Error extends Error {
  override name = 'Channel3Error';
}

/** Channel3 answered the search with a status outside 2xx. */
export class Channel3ApiError extends Channel3Error {
  override name = 'Channel3ApiError';

  constructor(
    readonly status: number,
    /** The full response body. The message keeps only its start. */
    readonly body: string,
  ) {
    super(`Channel3 ${status} on /v1/search: ${body.slice(0, 300)}`);
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
const Amount = z.union([z.number(), z.string()]).nullish();
const Offer = z.object({
  url: z.string(),
  domain: z.string(),
  // The API reference names the amount `price`; one of its guides calls it `amount`. Both are read.
  price: z.object({ price: Amount, amount: Amount, currency: z.string() }),
  availability: z.string(),
  condition: z.string().nullish(),
});
type Offer = z.infer<typeof Offer>;

let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Products on the open web matching `query`, at most `limit` (default 5), each listing only its
 * offers that are in stock, new and priced in USD. A product left with none has no offers and a
 * null median. A 429 is retried twice, waiting as Retry-After asks up to 5 seconds, then
 * surfaces as a `Channel3ApiError`, as does any other status outside 2xx at once. A request that
 * takes over 10 seconds, or a body that is not a search response, is a `Channel3Error`, also not
 * retried. Other network errors propagate. Throws before any request when CHANNEL3_API_KEY is not
 * set or is not a well-formed key, naming the variable but never quoting its value.
 */
export async function searchMarket(
  query: string,
  opts: { limit?: number; fetch?: typeof fetch } = {},
): Promise<MarketProduct[]> {
  const apiKey = process.env.CHANNEL3_API_KEY;
  if (!apiKey) throw new Error('CHANNEL3_API_KEY must be set to search Channel3 (see .env.example)');
  if (!API_KEY.test(apiKey)) {
    throw new Error('CHANNEL3_API_KEY must be printable ASCII without spaces or line breaks (see .env.example)');
  }
  const send = opts.fetch ?? fetch;
  // The API's default filters are in stock and new; sending any filters replaces them, so both are stated.
  const body = JSON.stringify({
    query,
    limit: opts.limit ?? DEFAULT_LIMIT,
    filters: { availability: ['InStock'], conditions: ['new'] },
  });

  for (let retries = 0; ; retries++) {
    const res = await post(send, apiKey, body);
    if (res.status >= 200 && res.status < 300) return marketProducts(res.text);
    if (res.status === 429 && retries < MAX_RETRIES) {
      await sleep(retryWait(res.retryAfter));
      continue;
    }
    throw new Channel3ApiError(res.status, res.text);
  }
}

/** One search request, read to the end within `TIMEOUT_MS`. */
async function post(
  send: typeof fetch,
  apiKey: string,
  body: string,
): Promise<{ status: number; retryAfter: string | null; text: string }> {
  try {
    const res = await send(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Channel3Error(`Channel3 did not answer the search within ${TIMEOUT_MS / 1000} seconds`, { cause: error });
    }
    throw error;
  }
}

function marketProducts(text: string): MarketProduct[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Channel3Error('Channel3 sent an unexpected search response: the body is not JSON');
  }
  const response = SearchResponse.safeParse(json);
  if (!response.success) throw new Channel3Error('Channel3 sent an unexpected search response: it has no product list');

  return valid(Product, response.data.products).map((product) => {
    // Channel3 returns every offer of a matching product, including ones its filters did not match.
    const offers = valid(Offer, product.offers ?? []).flatMap((offer) => marketOffer(offer) ?? []);
    const brand = valid(Brand, product.brands ?? [])[0];
    return {
      id: product.id,
      title: oneLine(product.title, TEXT_MAX),
      brand: brand ? oneLine(brand.name, TEXT_MAX) || null : null,
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

/**
 * The offer in cents when it is in stock, new, priced in USD at a storable whole number of cents
 * and linked over http. Null for any other offer, including one whose condition is unknown.
 */
function marketOffer(offer: Offer): MarketOffer | null {
  if (offer.availability !== 'InStock' || offer.condition !== 'new' || offer.price.currency !== 'USD') return null;
  const amount = offer.price.price ?? offer.price.amount;
  const priceCents = amount == null ? null : cents(amount);
  const url = webUrl(offer.url);
  if (priceCents === null || priceCents < 1 || priceCents > INT_MAX || url === null) return null;
  return { domain: offer.domain, priceCents, availability: offer.availability, url };
}

/**
 * Dollars as whole cents, read from the decimal text so no binary fraction shifts a half cent:
 * 1.005 is 101. Rounds half up on the third decimal. Null for anything that is not plain decimal
 * text, including exponent forms such as 1e3.
 */
function cents(amount: number | string): number | null {
  const match = DECIMAL.exec(typeof amount === 'number' ? String(amount) : amount);
  if (match === null) return null;
  const [, whole, fraction = ''] = match;
  const digits = fraction.padEnd(3, '0');
  const result = Number(whole) * 100 + Number(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(result) ? result : null;
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
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The wait Retry-After asks for, as a number of seconds or as the time until an HTTP date, at most
 * `MAX_WAIT_MS`. `DEFAULT_WAIT_MS` when the header is absent or gives neither. A plain number,
 * whole or not, is always seconds: `Date.parse` would read `1.5` as a date.
 */
function retryWait(retryAfter: string | null): number {
  const text = retryAfter?.trim() ?? '';
  if (/^\d+(\.\d+)?$/.test(text)) return Math.min(Number(text) * 1000, MAX_WAIT_MS);
  // An HTTP date always names its day and month; without letters, Date.parse would read "+5" or "-1"
  // as a date long past and the retry would not wait at all.
  const date = /[A-Za-z]/.test(text) ? Date.parse(text) : Number.NaN;
  if (Number.isNaN(date)) return DEFAULT_WAIT_MS;
  return Math.min(Math.max(date - Date.now(), 0), MAX_WAIT_MS);
}

/** For tests: replace the wait between retries, so tests neither sleep nor depend on timers. */
export function setChannel3RetrySleepForTests(wait: (ms: number) => Promise<void>): void {
  sleep = wait;
}
