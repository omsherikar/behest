// The size a product photo is downsized to before upload. Kept apart from the canvas work in
// app/seller/downsize.ts, which needs a browser, so the arithmetic can be tested on its own.

/**
 * The width and height, in whole pixels, of a `width` by `height` image scaled so its long edge is
 * at most `longEdge`, keeping its proportions; an image already within it keeps its size. Null when
 * the image has no size of its own, as an SVG without a width and height reports 0.
 */
export function downsizedSize(width: number, height: number, longEdge: number): { width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
