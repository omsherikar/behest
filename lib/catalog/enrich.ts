import { searchMarket } from '@/lib/channel3/client';
import type { ListingDraft } from './build';

// Enrichment gives a new listing a market benchmark: the Channel3 product it matches and that
// product's median price on the open web, which the gate compares purchase prices against.

/**
 * The first Channel3 result for the draft's title as its match and benchmark, or null when there is
 * no result or the first has no median. A median below 0.2 times or above 5 times the draft price
 * means the match is probably another product, such as a sample or a bulk pack, so it is rejected
 * too. Search failures propagate, so the caller can tell "no benchmark" from "could not look".
 */
export async function enrichListing(
  draft: Pick<ListingDraft, 'title' | 'priceCents'>,
  search: typeof searchMarket = searchMarket,
): Promise<{ channel3Id: string; marketMedianCents: number } | null> {
  const [match] = await search(draft.title, { limit: 1 });
  const median = match?.medianPriceCents ?? null;
  if (median === null) return null;
  // Between 0.2 and 5 times the price, ends included, in whole numbers so no fraction is rounded.
  if (draft.priceCents > median * 5 || median > draft.priceCents * 5) return null;
  return { channel3Id: match.id, marketMedianCents: median };
}
