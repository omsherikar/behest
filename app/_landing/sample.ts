import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import sample from '@/lib/demo/sample-receipt.json';
import type { RuleResult } from '@/components/ui/rule-results';
import { base64UrlText } from '@/lib/ui/jws';

// The landing page's sample purchase, read from the signed tokens in lib/demo/sample-receipt.json
// (made by scripts/sample-receipt.ts and checked by tests/demo/sample-receipt.test.ts). The page
// shows what the tokens say, so every value on it is one a reader can decode from the token.

/** The claims of a compact JWS, parsed by `schema`. The fixture's test verifies the signature. */
function claims<T>(jws: string, schema: { parse: (value: unknown) => T }): T {
  const text = base64UrlText(jws.split('.')[1] ?? '');
  if (text === null) throw new Error('the sample token does not decode');
  return schema.parse(JSON.parse(text));
}

export const SAMPLE = {
  receiptJws: sample.receiptJws,
  mandateJws: sample.mandateJws,
  receipt: claims(sample.receiptJws, ReceiptPayload),
  mandate: claims(sample.mandateJws, MandatePayload),
  outcomes: sample.outcomes as RuleResult[],
  item: sample.cart.items[0],
  sellerName: sample.cart.seller.name,
  keyId: sample.jwks.keys[0].kid,
};

/** A UTC time as "2026-11-07 14:02 UTC". */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
