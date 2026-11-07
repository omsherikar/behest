// Product photos are downsized in the browser before upload, so a phone photo of several megabytes
// arrives as a JPEG of a few hundred kilobytes: well inside the upload limits, and no larger than the
// model looks at anyway. The browser does the work with a canvas, so this runs only in the browser.

import { downsizedSize } from '@/lib/seller-pages/photo-size';

/** JPEG quality for the re-encoded photo: high enough that labels on a product stay legible. */
const JPEG_QUALITY = 0.85;

export type DownsizedPhoto = { mediaType: 'image/jpeg'; base64: string };

/**
 * `file` as a JPEG whose long edge is at most `longEdge` pixels, in base64 without a `data:` prefix.
 * A smaller photo keeps its size and is only re-encoded. Rejects when the browser cannot open the
 * file as an image, or the image has no size of its own (an SVG without one), which would otherwise
 * come out as a 1 by 1 pixel JPEG.
 */
export async function downsizePhoto(file: File, longEdge: number): Promise<DownsizedPhoto> {
  const url = URL.createObjectURL(file);
  try {
    const image = document.createElement('img');
    image.src = url;
    // Browsers decode with the photo's own orientation applied, so a phone photo stays upright.
    await image.decode();
    const size = downsizedSize(image.naturalWidth, image.naturalHeight, longEdge);
    if (!size) throw new Error('The image has no size of its own');
    const { width, height } = size;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw images');
    // JPEG has no transparency, so the clear parts of a PNG would otherwise turn black.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (blob?.type !== 'image/jpeg') throw new Error('This browser cannot save JPEG images');
    return { mediaType: 'image/jpeg', base64: await base64Of(blob) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The bytes of `blob` in base64, without the `data:` prefix a data URL starts with. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The photo could not be read'));
    reader.readAsDataURL(blob);
  });
}
