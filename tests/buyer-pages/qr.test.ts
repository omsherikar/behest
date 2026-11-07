import { describe, expect, it } from 'vitest';
import { qrDataUrl } from '@/lib/buyer-pages/qr';

const URL_TEXT = 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The PNG inside a base64 PNG data URL. */
function png(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
}

describe('qrDataUrl', () => {
  it('draws the text as a PNG data URL, 200 pixels square', async () => {
    const dataUrl = await qrDataUrl(URL_TEXT);
    expect(dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    const image = png(dataUrl);
    expect([...image.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    // The IHDR chunk follows the signature: length, type, then width and height as 32-bit integers.
    expect(image.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([200, 200]);
  });

  it('draws the same code for the same text, and another for other text', async () => {
    expect(await qrDataUrl(URL_TEXT)).toBe(await qrDataUrl(URL_TEXT));
    expect(await qrDataUrl(`${URL_TEXT}X`)).not.toBe(await qrDataUrl(URL_TEXT));
  });
});
