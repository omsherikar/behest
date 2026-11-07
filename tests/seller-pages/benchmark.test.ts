import { describe, expect, it } from 'vitest';
import { PRICE_ANOMALY_RATIO } from '@/lib/gate/rules';
import { benchmark } from '@/lib/seller-pages/benchmark';

describe('benchmark', () => {
  it('says how far above the median a price is', () => {
    expect(benchmark(1200, 800)).toEqual({ medianCents: 800, percent: 50, words: '50% above the $8.00 median', asks: false });
  });

  it('says how far below it a price is', () => {
    expect(benchmark(350, 400)).toMatchObject({ percent: -13, words: '13% below the $4.00 median', asks: false });
  });

  it('says when a price is at the median', () => {
    expect(benchmark(450, 450)).toMatchObject({ percent: 0, words: 'At the $4.50 median' });
  });

  it('marks a price the gate asks the buyer about, as the gate measures it', () => {
    expect(PRICE_ANOMALY_RATIO).toBe(1.5);
    expect(benchmark(1200, 800)?.asks).toBe(false);
    expect(benchmark(1201, 800)).toMatchObject({ percent: 50, asks: true });
    expect(benchmark(2000, 800)).toMatchObject({ percent: 150, asks: true });
  });

  it('is null without a market median', () => {
    expect(benchmark(450, null)).toBeNull();
    expect(benchmark(450, 0)).toBeNull();
  });
});
