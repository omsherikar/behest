import { searchMarket } from '@/lib/channel3/client';
import type { ListingDraft } from './build';

// Enrichment gives a new listing a market benchmark: the Channel3 product it matches and that
// product's median price on the open web, which the gate compares purchase prices against.

/**
 * The first Channel3 result for the draft's title as its match and benchmark, or null when there is
 * no result or the first has no median. A median below the draft price is kept however far below,
 * because the gate holds a price over 1.5 times its median for the buyer, so a seller pricing far
 * above the market is caught rather than let through. A median over 5 times the draft price is
 * rejected: a listing far cheaper than the market cannot hurt the buyer on price, and such a match is
 * most likely another product, such as a bulk pack. A median of 0 benchmarks nothing and is rejected
 * too. Search failures propagate, so the caller can tell "no benchmark" from "could not look".
 */
export async function enrichListing(
  draft: Pick<ListingDraft, 'title' | 'priceCents'>,
  search: typeof searchMarket = searchMarket,
): Promise<{ channel3Id: string; marketMedianCents: number } | null> {
  const [match] = await search(draft.title, { limit: 1 });
  const median = match?.medianPriceCents ?? null;
  if (median === null) return null;
  // Above 0 and at most 5 times the price, end included, in whole numbers so no fraction is rounded.
  // Written as what is accepted, so a price that is not a number never is.
  if (!(median > 0 && median <= draft.priceCents * 5)) return null;
  return { channel3Id: match.id, marketMedianCents: median };
}
