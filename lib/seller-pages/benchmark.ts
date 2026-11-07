import { formatUsd } from '@/lib/domain/money';
import { PRICE_ANOMALY_RATIO } from '@/lib/gate/rules';

// A listing's price beside its market benchmark, for the seller's catalog: the median of the same
// product elsewhere, how far the seller's price is from it, and whether it is far enough above that
// the policy gate asks the buyer before their agent pays (the gate's own price_benchmark rule).

export type Benchmark = {
  medianCents: number;
  /** How far the price is from the median, in whole percent: positive above it, negative below. */
  percent: number;
  /** The comparison in words, such as "50% above the $8.00 median". */
  words: string;
  /** Whether the gate asks the buyer about this price: above PRICE_ANOMALY_RATIO times the median. */
  asks: boolean;
};

/** The benchmark of a listing priced `priceCents`, or null when it has no market median. */
export function benchmark(priceCents: number, medianCents: number | null): Benchmark | null {
  if (medianCents === null || !(medianCents > 0)) return null;
  // Rounded half away from zero, so 12.5% below reads as 13% below, as 12.5% above reads as 13% above.
  const exact = ((priceCents - medianCents) / medianCents) * 100;
  const percent = Math.sign(exact) * Math.round(Math.abs(exact));
  const median = formatUsd(medianCents);
  const words =
    percent === 0
      ? `At the ${median} median`
      : `${Math.abs(percent)}% ${percent > 0 ? 'above' : 'below'} the ${median} median`;
  return { medianCents, percent, words, asks: priceCents > PRICE_ANOMALY_RATIO * medianCents };
}
