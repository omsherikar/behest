import { MandatePayload, ReceiptPayload } from '@/lib/domain/receipt';
import type { MandatePolicy } from '@/lib/domain/policy';
import sample from '@/lib/demo/sample-receipt.json';
import type { RuleResult } from '@/components/ui/rule-results';
import { evaluateGate } from '@/lib/gate/evaluate';
import { renderReadback } from '@/lib/mandate/readback';
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

/**
 * The policy the sample mandate signs: the same object as in scripts/sample-receipt.ts, and the demo's
 * "$60 a month on groceries and spices, ask me above $25, never electronics". The sample receipt's
 * test checks that its hash is the mandate's policy hash.
 */
export const SAMPLE_POLICY: MandatePolicy = {
  version: 1,
  currency: 'USD',
  budget: { amountCents: 6000, period: 'month' },
  perPurchaseMaxCents: 6000,
  askAboveCents: 2500,
  categories: { allow: ['groceries', 'spices'], deny: ['electronics'] },
  merchants: { allow: null, deny: [] },
  velocity: null,
  expiresAt: null,
};

/** The readback the buyer confirms for the sample policy, as the code renders it. */
export const SAMPLE_READBACK = renderReadback(SAMPLE_POLICY);

/**
 * What the gate says about a cart the sample mandate forbids: wireless earbuds from the same seller,
 * under the same mandate, run through the real gate. Its category rule blocks.
 */
export function forbiddenCartOutcome(): RuleResult {
  const result = evaluateGate({
    policy: SAMPLE_POLICY,
    mandate: { status: 'active', expiresAt: null },
    walletLinked: true,
    seller: sample.cart.seller,
    proposal: { sellerSlug: sample.cart.seller.slug, items: [{ sku: 'EAR-01', quantity: 1 }], rationale: 'Earbuds.' },
    catalog: new Map([
      ['EAR-01', { sku: 'EAR-01', title: 'Wireless earbuds', category: 'electronics', priceCents: 2400, stock: 10, flags: [], marketMedianCents: null }],
    ]),
    spentInPeriodCents: 0,
    recentPurchaseTimes: [],
    now: new Date(SAMPLE.receipt.payment.capturedAt),
  });
  const blocked = result.outcomes.find((outcome) => outcome.result === 'block');
  if (!blocked) throw new Error('the gate should block electronics under the sample mandate');
  return blocked;
}

/** A UTC time as "2026-11-07 14:02 UTC". */
export function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
