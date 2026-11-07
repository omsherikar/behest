import { toDataURL } from 'qrcode';

// QR codes of approval links, so a buyer can approve on their phone. They are drawn on the server
// as PNG data URLs, which the page shows in an image, so no markup is built from the link.

/** A QR code of `text` as a PNG data URL, 200 pixels square, with medium error correction. */
export function qrDataUrl(text: string): Promise<string> {
  return toDataURL(text, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 200 });
}
