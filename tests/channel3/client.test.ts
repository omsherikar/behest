import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, type FakeRoute } from '@/tests/helpers/fake-fetch';
import searchTurmeric from '@/tests/fixtures/channel3/search-turmeric.json';
import { Channel3ApiError, Channel3Error, searchMarket, setChannel3RetrySleepForTests } from '@/lib/channel3/client';

const SEARCH = '/v1/search';
const KEY = 'c3-test-key';

const found = (body: unknown): FakeRoute => ({ method: 'POST', path: SEARCH, body });

const failing = (status: number): FakeRoute => ({
  method: 'POST',
  path: SEARCH,
  status,
  body: { detail: `Channel3 answered ${status}` },
  once: true,
});

/** An offer in the shape Channel3 sends, priced in dollars, in stock and new unless `fields` say otherwise. */
const offer = (price: number | string, currency = 'USD', domain = 'spicebarn.com', fields: Record<string, unknown> = {}) => ({
  url: `https://buy.trychannel3.com/r/${domain}-${price}`,
  domain,
  price: { price, compare_at_price: null, currency },
  availability: 'InStock',
  condition: 'new',
  max_commission_rate: 0,
  dimensions: null,
  ...fields,
});

/** A search response holding one product with `offers`. */
const oneProduct = (offers: unknown[], fields: Record<string, unknown> = {}) => ({
  products: [{ id: 'p1', title: 'Ground turmeric', brands: [], images: [], offers, ...fields }],
  next_page_token: null,
});

/** The cents searchMarket reads from one USD offer, or undefined when it drops the offer. */
async function centsOf(price: Record<string, unknown>): Promise<number | undefined> {
  const { fetch } = fakeFetch([found(oneProduct([{ ...offer(1), price: { currency: 'USD', ...price } }]))]);
  const [product] = await searchMarket('turmeric', { fetch });
  return product.offers[0]?.priceCents;
}

let sleeps: number[];

beforeEach(() => {
  vi.stubEnv('CHANNEL3_API_KEY', KEY);
  sleeps = [];
  setChannel3RetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('searchMarket request', () => {
  it('posts the query to the search endpoint with the API key, five results and offers in stock and new', async () => {
    const { fetch, calls } = fakeFetch([found(searchTurmeric)]);

    await searchMarket('turmeric powder', { fetch });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.trychannel3.com/v1/search');
    expect(calls[0].headers['x-api-key']).toBe(KEY);
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? '')).toEqual({
      query: 'turmeric powder',
      limit: 5,
      filters: { availability: ['InStock'], conditions: ['new'] },
    });
  });

  it('asks for the number of results given', async () => {
    const { fetch, calls } = fakeFetch([found(searchTurmeric)]);

    await searchMarket('turmeric powder', { limit: 1, fetch });

    expect(JSON.parse(calls[0].body ?? '')).toMatchObject({ limit: 1 });
  });

  it('reads the API key when called, and without one makes no request', async () => {
    vi.stubEnv('CHANNEL3_API_KEY', '');
    const { fetch, calls } = fakeFetch([found(searchTurmeric)]);

    await expect(searchMarket('turmeric powder', { fetch })).rejects.toThrow(/CHANNEL3_API_KEY/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a line break', 'c3-secret\nkey'],
    ['a trailing line break', 'c3-secret-key\r\n'],
    ['a space', 'c3-secret key'],
    ['a non-ASCII letter', 'c3-sécret-key'],
  ])('refuses a key with %s before any request, naming the variable and not the key', async (_what, key) => {
    vi.stubEnv('CHANNEL3_API_KEY', key);
    const { fetch, calls } = fakeFetch([found(searchTurmeric)]);

    const error = await searchMarket('turmeric powder', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CHANNEL3_API_KEY/);
    expect((error as Error).message).not.toContain('c3-');
    expect((error as Error).message).not.toContain('secret');
    expect(calls).toHaveLength(0);
  });
});

describe('searchMarket results', () => {
  it('turns each product into a market product with its USD offers in cents', async () => {
    const { fetch } = fakeFetch([found(searchTurmeric)]);

    const products = await searchMarket('turmeric powder', { fetch });

    expect(products).toHaveLength(3);
    expect(products[0]).toEqual({
      id: '4qTz8Lm',
      title: 'Organic Ground Turmeric Root Powder, 2.4 oz Jar',
      brand: 'Kesar Valley',
      imageUrl: 'https://cdn.trychannel3.com/cleaned/4qTz8Lm-front.png',
      offers: [
        {
          domain: 'spicebarn.com',
          priceCents: 250,
          availability: 'InStock',
          url: 'https://buy.trychannel3.com/r/4qTz8Lm-spicebarn',
        },
        {
          domain: 'pantryhouse.com',
          priceCents: 300,
          availability: 'InStock',
          url: 'https://buy.trychannel3.com/r/4qTz8Lm-pantryhouse',
        },
        {
          domain: 'gourmetgrocer.com',
          priceCents: 900,
          availability: 'InStock',
          url: 'https://buy.trychannel3.com/r/4qTz8Lm-gourmetgrocer',
        },
      ],
      medianPriceCents: 300,
    });
    expect(products[1]).toMatchObject({
      id: '9Hc2vNe',
      brand: null,
      imageUrl: 'https://images.example-merchant.com/haldi-pouch.jpg',
    });
    expect(products[2]).toMatchObject({ id: 'Rb71xQa', imageUrl: null });
  });

  it('gives the median of offers at 250, 300 and 900 cents as 300', async () => {
    const { fetch } = fakeFetch([found(oneProduct([offer(9), offer(2.5), offer(3)]))]);

    const [product] = await searchMarket('turmeric', { fetch });

    expect(product.medianPriceCents).toBe(300);
  });

  it('gives the median of an even count as the mean of the middle two, rounded down to a whole cent', async () => {
    const { fetch } = fakeFetch([found(oneProduct([offer(6), offer(5.49), offer(1), offer(20)]))]);

    const [product] = await searchMarket('turmeric', { fetch });

    // The middle two are 549 and 600, whose mean is 574.5.
    expect(product.medianPriceCents).toBe(574);
  });

  it('lists offers out of stock, used or of unknown condition, but leaves them out of the median', async () => {
    const mixed = fakeFetch([
      found(
        oneProduct([
          offer(3),
          offer(1, 'USD', 'resale.com', { condition: 'used' }),
          offer(2, 'USD', 'soldout.com', { availability: 'OutOfStock' }),
          offer(2.5, 'USD', 'unknown.com', { condition: null }),
        ]),
      ),
    ]);
    const onlySoldOut = fakeFetch([found(oneProduct([offer(2, 'USD', 'soldout.com', { availability: 'OutOfStock' })]))]);

    const [product] = await searchMarket('turmeric', { fetch: mixed.fetch });
    const [soldOut] = await searchMarket('turmeric', { fetch: onlySoldOut.fetch });

    expect(product.offers.map((o) => o.domain)).toEqual(['spicebarn.com', 'resale.com', 'soldout.com', 'unknown.com']);
    expect(product.medianPriceCents).toBe(300);
    expect(soldOut.offers).toHaveLength(1);
    expect(soldOut.medianPriceCents).toBeNull();
  });

  it('ignores offers in currencies other than USD, for the offers and the median', async () => {
    const { fetch } = fakeFetch([
      found(oneProduct([offer(3), offer(0.5, 'EUR', 'gewuerzhaus.de'), offer(1, 'CAD', 'maplepantry.ca')])),
    ]);

    const [product] = await searchMarket('turmeric', { fetch });

    expect(product.offers.map((o) => o.domain)).toEqual(['spicebarn.com']);
    expect(product.medianPriceCents).toBe(300);
  });

  it('gives no median to a product without USD offers', async () => {
    const { fetch } = fakeFetch([found(searchTurmeric)]);

    const products = await searchMarket('turmeric powder', { fetch });

    expect(products[2].offers).toEqual([]);
    expect(products[2].medianPriceCents).toBeNull();
  });

  it('reads the amount from price, or from amount when price is missing', async () => {
    expect(await centsOf({ price: 3 })).toBe(300);
    expect(await centsOf({ amount: 4.5 })).toBe(450);
    expect(await centsOf({ amount: '4.00' })).toBe(400);
    expect(await centsOf({ price: null, amount: 7 })).toBe(700);
    expect(await centsOf({ price: 3, amount: 9 })).toBe(300);
    expect(await centsOf({})).toBeUndefined();
  });

  it('converts dollars to cents from the decimal text, rounding half up on the third decimal', async () => {
    expect(await centsOf({ price: 1.005 })).toBe(101);
    expect(await centsOf({ price: 0.145 })).toBe(15);
    expect(await centsOf({ price: 2.675 })).toBe(268);
    expect(await centsOf({ price: 1.0049 })).toBe(100);
    expect(await centsOf({ price: 0.1 + 0.2 })).toBe(30);
    expect(await centsOf({ price: '12' })).toBe(1200);
  });

  it('drops amounts that are not plain decimal text', async () => {
    expect(await centsOf({ amount: '1e3' })).toBeUndefined();
    expect(await centsOf({ price: 1e21 })).toBeUndefined();
    expect(await centsOf({ price: 1e-7 })).toBeUndefined();
    expect(await centsOf({ price: -3 })).toBeUndefined();
    expect(await centsOf({ amount: ' 4.00' })).toBeUndefined();
    expect(await centsOf({ amount: '$4.00' })).toBeUndefined();
    expect(await centsOf({ amount: '4.' })).toBeUndefined();
    expect(await centsOf({ price: '99999999999999999999' })).toBeUndefined();
  });

  it('cuts titles and brands to 120 characters on one line', async () => {
    const longBrand = `Kesar ${'Valley '.repeat(30)}`;
    const { fetch } = fakeFetch([
      found({
        products: [
          { ...searchTurmeric.products[1], brands: [{ id: 'b1', name: longBrand }] },
          { id: 'p2', title: 'Ground\n\nturmeric​   powder', brands: [{ id: 'b2', name: 'Kesar\nValley' }], offers: [] },
          { id: 'p3', title: 'Turmeric', brands: [{ id: 'b3', name: ' ​ ' }], offers: [] },
        ],
      }),
    ]);

    const products = await searchMarket('turmeric powder', { fetch });

    expect(products[0].title).toBe(
      'Turmeric Powder (Haldi) 7 oz Resealable Pouch, Bright Yellow Lakadong Variety With High Curcumin Content, Ideal for Curr',
    );
    expect(products[0].brand).toBe(longBrand.trim().slice(0, 120).trimEnd());
    expect(products[0].brand?.length).toBeLessThanOrEqual(120);
    expect(products[1].title).toBe('Ground turmeric powder');
    expect(products[1].brand).toBe('Kesar Valley');
    expect(products[2].brand).toBeNull();
  });

  it('drops products and offers that are malformed, priced below a cent or not linked over http', async () => {
    const { fetch } = fakeFetch([
      found({
        products: [
          { title: 'No id', offers: [offer(3)] },
          {
            id: 'p1',
            title: 'Ground turmeric',
            offers: [
              offer(3),
              { domain: 'nourl.com', price: { price: 4, currency: 'USD' }, availability: 'InStock' },
              { ...offer(4), price: { price: { value: 4 }, currency: 'USD' } },
              offer(0, 'USD', 'free.com'),
              offer(0.004, 'USD', 'fraction.com'),
              { ...offer(5), url: 'javascript:alert(1)' },
            ],
          },
        ],
      }),
    ]);

    const products = await searchMarket('turmeric', { fetch });

    expect(products).toHaveLength(1);
    expect(products[0].offers).toEqual([
      { domain: 'spicebarn.com', priceCents: 300, availability: 'InStock', url: 'https://buy.trychannel3.com/r/spicebarn.com-3' },
    ]);
  });

  it('fails on a response without a product list', async () => {
    const { fetch } = fakeFetch([found({ detail: 'not a search' })]);

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3Error);
    expect((error as Error).message).toMatch(/unexpected search response: it has no product list/);
  });

  it('fails on a 2xx body that is not JSON, with the same Channel3 error', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('<html>Gateway</html>', { status: 200 });

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3Error);
    expect((error as Error).message).toMatch(/unexpected search response: the body is not JSON/);
  });
});

describe('searchMarket errors', () => {
  it('surfaces a 429 as an error after two retries, waiting 1 second each when Retry-After is absent', async () => {
    const { fetch, calls } = fakeFetch([failing(429), failing(429), failing(429), failing(429), found(searchTurmeric)]);

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3ApiError);
    expect(error).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('returns the results when a retry after a 429 succeeds', async () => {
    const { fetch, calls } = fakeFetch([failing(429), found(searchTurmeric)]);

    const products = await searchMarket('turmeric', { fetch });

    expect(products).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it('waits as many seconds as Retry-After says, at most 5, and 1 second when it says nothing usable', async () => {
    const waits = ['2', '60', 'soon'];
    const fetch: typeof globalThis.fetch = async () => {
      const retryAfter = waits.shift();
      return retryAfter === undefined
        ? Response.json({ products: [] })
        : Response.json({ detail: 'Too Many Requests' }, { status: 429, headers: { 'retry-after': retryAfter } });
    };

    await expect(searchMarket('turmeric', { fetch })).rejects.toMatchObject({ status: 429 });
    expect(sleeps).toEqual([2000, 5000]);

    waits.splice(0, waits.length, 'soon');
    sleeps = [];
    await expect(searchMarket('turmeric', { fetch })).resolves.toEqual([]);
    expect(sleeps).toEqual([1000]);
  });

  it('waits until a Retry-After date, at most 5 seconds and not at all for a date already past', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const waits = ['Fri, 06 Nov 2026 12:00:03 GMT', 'Fri, 06 Nov 2026 12:01:00 GMT'];
    const fetch: typeof globalThis.fetch = async () => {
      const retryAfter = waits.shift();
      return retryAfter === undefined
        ? Response.json({ products: [] })
        : Response.json({ detail: 'Too Many Requests' }, { status: 429, headers: { 'retry-after': retryAfter } });
    };

    await expect(searchMarket('turmeric', { fetch })).resolves.toEqual([]);
    expect(sleeps).toEqual([3000, 5000]);

    waits.push('Fri, 06 Nov 2026 11:59:00 GMT');
    sleeps = [];
    await expect(searchMarket('turmeric', { fetch })).resolves.toEqual([]);
    expect(sleeps).toEqual([0]);
  });

  it.each([400, 401, 402, 422, 500, 503, 504])('fails a %i at once, carrying the status but not the key', async (status) => {
    const { fetch, calls } = fakeFetch([failing(status), found(searchTurmeric)]);

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3ApiError);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).toContain(`Channel3 answered ${status}`);
    expect((error as Error).message).not.toContain(KEY);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('gives each request 10 seconds, and fails a timeout at once as a Channel3 error', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      signals.push(init?.signal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3Error);
    expect(error).not.toBeInstanceOf(Channel3ApiError);
    expect((error as Error).message).toBe('Channel3 did not answer the search within 10 seconds');
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(signals).toEqual([timeout.mock.results[0].value]);
    expect(sleeps).toEqual([]);
  });

  it('lets other network errors propagate as they are', async () => {
    const lost = new TypeError('fetch failed');
    const fetch: typeof globalThis.fetch = async () => {
      throw lost;
    };

    await expect(searchMarket('turmeric', { fetch })).rejects.toBe(lost);
  });
});
