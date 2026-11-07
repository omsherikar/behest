import { describe, expect, it } from 'vitest';
import { downsizedSize } from '@/lib/seller-pages/photo-size';

describe('downsizedSize', () => {
  it('scales a landscape photo so its width is the long edge', () => {
    expect(downsizedSize(4032, 3024, 1568)).toEqual({ width: 1568, height: 1176 });
  });

  it('scales a portrait photo so its height is the long edge', () => {
    expect(downsizedSize(900, 2400, 1568)).toEqual({ width: 588, height: 1568 });
  });

  it('keeps a photo that is already small enough at its own size', () => {
    expect(downsizedSize(800, 600, 1568)).toEqual({ width: 800, height: 600 });
    expect(downsizedSize(1568, 1000, 1568)).toEqual({ width: 1568, height: 1000 });
  });

  it('never rounds the short edge down to nothing', () => {
    expect(downsizedSize(100_000, 10, 1568)).toEqual({ width: 1568, height: 1 });
  });

  it('is null for an image with no size of its own, such as an SVG without one', () => {
    expect(downsizedSize(0, 0, 1568)).toBeNull();
    expect(downsizedSize(0, 300, 1568)).toBeNull();
    expect(downsizedSize(300, 0, 1568)).toBeNull();
    expect(downsizedSize(Number.NaN, 300, 1568)).toBeNull();
  });
});
