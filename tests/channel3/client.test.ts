import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, type FakeRoute } from '@/tests/helpers/fake-fetch';
import searchTurmeric from '@/tests/fixtures/channel3/search-turmeric.json';
import { Channel3ApiError, searchMarket, setChannel3RetrySleepForTests } from '@/lib/channel3/client';

const SEARCH = '/v1/search';

const found = (body: unknown): FakeRoute => ({ method: 'POST', path: SEARCH, body });

const failing = (status: number): FakeRoute => ({
  method: 'POST',
  path: SEARCH,
  status,
  body: { detail: `Channel3 answered ${status}` },
  once: true,
});

/** An offer in the shape Channel3 sends, priced in dollars. */
const offer = (price: number, currency = 'USD', domain = 'spicebarn.com') => ({
  url: `https://buy.trychannel3.com/r/${domain}-${price}`,
  domain,
  price: { price, compare_at_price: null, currency },
  availability: 'InStock',
  condition: 'new',
  max_commission_rate: 0,
  dimensions: null,
});

/** A search response holding one product with `offers`. */
const oneProduct = (offers: unknown[], fields: Record<string, unknown> = {}) => ({
  products: [{ id: 'p1', title: 'Ground turmeric', brands: [], images: [], offers, ...fields }],
  next_page_token: null,
});

let sleeps: number[];

beforeEach(() => {
  vi.stubEnv('CHANNEL3_API_KEY', 'c3-test-key');
  sleeps = [];
  setChannel3RetrySleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('searchMarket request', () => {
  it('posts the query to the search endpoint with the API key, five results and in-stock offers only', async () => {
    const { fetch, calls } = fakeFetch([found(searchTurmeric)]);

    await searchMarket('turmeric powder', { fetch });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.trychannel3.com/v1/search');
    expect(calls[0].headers['x-api-key']).toBe('c3-test-key');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0].body ?? '')).toEqual({
      query: 'turmeric powder',
      limit: 5,
      filters: { availability: ['InStock'] },
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

  it('cuts titles to 120 characters on one line', async () => {
    const { fetch } = fakeFetch([
      found({
        products: [
          searchTurmeric.products[1],
          { id: 'p2', title: 'Ground\n\nturmeric​   powder', offers: [] },
        ],
      }),
    ]);

    const products = await searchMarket('turmeric powder', { fetch });

    expect(products[0].title).toBe(
      'Turmeric Powder (Haldi) 7 oz Resealable Pouch, Bright Yellow Lakadong Variety With High Curcumin Content, Ideal for Curr',
    );
    expect(products[1].title).toBe('Ground turmeric powder');
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
              { ...offer(4), price: { price: '4.00', currency: 'USD' } },
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

    await expect(searchMarket('turmeric', { fetch })).rejects.toThrow(/unexpected/);
  });
});

describe('searchMarket errors', () => {
  it('surfaces a 429 as an error after two retries', async () => {
    const { fetch, calls } = fakeFetch([failing(429), failing(429), failing(429), failing(429), found(searchTurmeric)]);

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3ApiError);
    expect(error).toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('returns the results when a retry after a 429 succeeds', async () => {
    const { fetch, calls } = fakeFetch([failing(429), found(searchTurmeric)]);

    const products = await searchMarket('turmeric', { fetch });

    expect(products).toHaveLength(3);
    expect(calls).toHaveLength(2);
  });

  it('waits as long as Retry-After says, at most 5 seconds, and 1 second when it says nothing usable', async () => {
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

  it.each([400, 401, 402, 422, 500, 503, 504])('fails a %i at once, carrying the status', async (status) => {
    const { fetch, calls } = fakeFetch([failing(status), found(searchTurmeric)]);

    const error = await searchMarket('turmeric', { fetch }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Channel3ApiError);
    expect(error).toMatchObject({ status });
    expect((error as Error).message).toContain(`Channel3 answered ${status}`);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
});
