import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { purchaseReasons } from '@/lib/buyer-pages/reasons';
import { purchases, type StoredIntentResult, type StoredRuleOutcome } from '@/lib/db/schema';
import { purchaseOutcome } from '@/lib/purchases/charge';
import { purchaseRow, seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

const outcomes: StoredRuleOutcome[] = [
  { rule: 'mandate_active', result: 'pass', detail: 'Your mandate is active.' },
  { rule: 'approval_limit', result: 'ask', detail: 'Over $25.00, so you approve it.' },
  { rule: 'market_price', result: 'skip', detail: 'No market price is known for this item.' },
  { rule: 'listing_flags', result: 'block', detail: 'The listing "Turmeric" speaks to AI agents.' },
];
const intent: StoredIntentResult = { verdict: 'needs_human', reasons: ['You asked for one jar; the cart has two.'] };

describe('purchaseReasons', () => {
  it('lists the gate rules that did not pass, in rule order, then the intent check reasons', () => {
    expect(purchaseReasons({ gateOutcomes: outcomes, intent })).toEqual([
      'Over $25.00, so you approve it.',
      'The listing "Turmeric" speaks to AI agents.',
      'You asked for one jar; the cart has two.',
    ]);
  });

  it('has only the gate reasons before the intent check has run, and none for a purchase that passed', () => {
    expect(purchaseReasons({ gateOutcomes: outcomes, intent: null })).toEqual([
      'Over $25.00, so you approve it.',
      'The listing "Turmeric" speaks to AI agents.',
    ]);
    expect(purchaseReasons({ gateOutcomes: [outcomes[0], outcomes[2]], intent: { verdict: 'consistent', reasons: [] } })).toEqual([]);
  });

  it('gives the reasons the purchase flow reports for the same purchase', async () => {
    const db = await createTestDb();
    const { purchaseId } = await seedPurchase(db, 'awaiting_approval');
    for (const stored of [
      { gateOutcomes: outcomes, intent },
      { gateOutcomes: outcomes, intent: null },
      { gateOutcomes: [], intent: { verdict: 'unavailable', reasons: ['The intent check did not answer.'] } as StoredIntentResult },
    ]) {
      await db.update(purchases).set(stored).where(eq(purchases.id, purchaseId));
      const row = await purchaseRow(db, purchaseId);
      expect(purchaseReasons(row)).toEqual((await purchaseOutcome(db, purchaseId)).reasons);
    }
  });
});
