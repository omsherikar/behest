import { describe, expect, it, vi } from 'vitest';
import type { MarketProduct, searchMarket } from '@/lib/channel3/client';
import { enrichListing } from '@/lib/catalog/enrich';
import type { ListingDraft } from '@/lib/catalog/build';

/** A $3.00 jar of turmeric, as the catalog builder drafts it. */
const draft: ListingDraft = {
  sku: 'TUR-100',
  title: 'Organic Ground Turmeric, 100 g',
  description: 'Stone-ground turmeric root.',
  category: 'spices',
  priceCents: 300,
  stock: 40,
  screening: { suspicious: false, reason: null },
};

const product = (id: string, medianPriceCents: number | null): MarketProduct => ({
  id,
  title: 'Ground turmeric',
  brand: null,
  imageUrl: null,
  offers: medianPriceCents === null ? [] : [{ domain: 'spicebarn.com', priceCents: medianPriceCents, availability: 'InStock', url: 'https://spicebarn.com/t' }],
  medianPriceCents,
});

/** A search that answers with `results` and records what it was asked. */
function searchReturning(...results: MarketProduct[]) {
  return vi.fn<typeof searchMarket>(async () => results);
}

describe('enrichListing', () => {
  it('searches for the draft title and takes the first result with its median', async () => {
    const search = searchReturning(product('c3-first', 280), product('c3-second', 310));

    await expect(enrichListing(draft, search)).resolves.toEqual({ channel3Id: 'c3-first', marketMedianCents: 280 });
    expect(search).toHaveBeenCalledExactlyOnceWith('Organic Ground Turmeric, 100 g', { limit: 1 });
  });

  it('rejects a match whose median is 10 times the draft price', async () => {
    await expect(enrichListing(draft, searchReturning(product('c3-pallet', 3000)))).resolves.toBeNull();
  });

  it('accepts a median from 0.2 to 5 times the draft price, both ends included', async () => {
    for (const [median, accepted] of [
      [59, false],
      [60, true],
      [1500, true],
      [1501, false],
    ] as const) {
      const result = await enrichListing(draft, searchReturning(product('c3', median)));
      expect(result === null ? 'rejected' : 'accepted').toBe(accepted ? 'accepted' : 'rejected');
    }
  });

  it('never accepts a first result without a median, even when a later one has one', async () => {
    const search = searchReturning(product('c3-no-usd', null), product('c3-usd', 300));

    await expect(enrichListing(draft, search)).resolves.toBeNull();
  });

  it('gives null when the search finds nothing', async () => {
    await expect(enrichListing(draft, searchReturning())).resolves.toBeNull();
  });

  it('lets a failed search propagate', async () => {
    const search = vi.fn<typeof searchMarket>(async () => {
      throw new Error('CHANNEL3_API_KEY must be set to search Channel3 (see .env.example)');
    });

    await expect(enrichListing(draft, search)).rejects.toThrow(/CHANNEL3_API_KEY/);
  });
});
