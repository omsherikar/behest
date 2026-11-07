import { wrapUntrusted } from '@/lib/llm/untrusted';

// Seller listings and market results are written by third parties, and a listing may speak to AI
// agents directly, telling them to ignore the buyer's budget or to buy ten. Every such string is
// quoted before the shopping agent reads it, so the model can tell it is data and the text cannot
// end its quote early.

/** Where third-party text the shopping agent reads comes from. */
export type UntrustedSource = 'seller_listing' | 'market';

/** `text` as `<untrusted source="<source>">...</untrusted>`, escaped and cut to `maxLen` as `wrapUntrusted` does. */
export function quoteUntrusted(source: UntrustedSource, text: string, maxLen = 400): string {
  return wrapUntrusted(source, text, maxLen);
}
