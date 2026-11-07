import { describe, expect, it } from 'vitest';
import { returnNotices } from '@/lib/buyer-pages/notices';

const ID = '6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7';

describe('returnNotices', () => {
  it('says the purchase was approved, and points to the ledger for the payment', () => {
    expect(returnNotices({ approved: ID })).toEqual([
      {
        tone: 'success',
        text: 'You approved the purchase at PayPal. Your ledger shows whether the payment went through.',
        ledger: true,
      },
    ]);
  });

  it('says nothing was paid when PayPal has not confirmed the approval, or the buyer left PayPal', () => {
    expect(returnNotices({ pending: ID })).toEqual([
      {
        tone: 'warning',
        text: 'PayPal has not confirmed your approval yet, so nothing was paid. If the purchase is still listed below, approve it at PayPal again.',
        ledger: false,
      },
    ]);
    expect(returnNotices({ cancelled: ID })).toEqual([
      { tone: 'warning', text: 'You left PayPal without approving the purchase, so nothing was paid.', ledger: false },
    ]);
  });

  it('words each error the return can end with', () => {
    expect(returnNotices({ error: 'unknown' })).toEqual([
      {
        tone: 'danger',
        text: 'Behest could not match that PayPal approval to one of your purchases, so nothing was done.',
        ledger: false,
      },
    ]);
    expect(returnNotices({ error: 'failed' })).toEqual([
      {
        tone: 'danger',
        text: 'Behest could not finish your approval just now. Wait a minute and open the PayPal link again. Your ledger shows where each purchase stands.',
        ledger: true,
      },
    ]);
  });

  it('shows nothing for an error it does not know, and never repeats what the link carries', () => {
    expect(returnNotices({})).toEqual([]);
    expect(returnNotices({ error: '<script>alert(1)</script>' })).toEqual([]);
    expect(returnNotices({ error: ['unknown', 'failed'] })).toEqual([]);
    const shown = JSON.stringify(returnNotices({ approved: '<b>x</b>', pending: 'ORDER-1', cancelled: 'y' }));
    expect(shown).not.toMatch(/<b>|ORDER-1/);
  });

  it('shows each notice the link asks for, in a fixed order', () => {
    const tones = returnNotices({ error: 'failed', cancelled: ID, pending: ID, approved: ID }).map((n) => n.tone);
    expect(tones).toEqual(['success', 'warning', 'warning', 'danger']);
  });
});
