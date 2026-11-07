import { describe, expect, it } from 'vitest';
import { purchaseStatus } from '@/lib/db/schema';
import { statusWords } from '@/lib/buyer-pages/words';

describe('statusWords', () => {
  it('says paid for a captured purchase and every status after it that kept the money', () => {
    expect(statusWords('captured')).toBe('Paid');
    expect(statusWords('accepted')).toBe('Paid');
    expect(statusWords('settled')).toBe('Paid');
    expect(statusWords('disputed')).toBe('Paid, in dispute');
    expect(statusWords('resolved')).toBe('Paid, dispute closed');
  });

  it('says a charge is still being confirmed, and that an asked purchase waits for PayPal', () => {
    expect(statusWords('charging')).toBe('Confirming payment');
    expect(statusWords('awaiting_approval')).toBe('Approve at PayPal');
  });

  it('says not bought for a purchase that was blocked, failed or cancelled', () => {
    expect(statusWords('blocked')).toBe('Not bought');
    expect(statusWords('failed')).toBe('Not bought');
    expect(statusWords('cancelled')).toBe('Not bought, approval cancelled');
  });

  it('words the rest of the lifecycle', () => {
    expect(statusWords('proposed')).toBe('Being checked');
    expect(statusWords('refunded')).toBe('Refunded');
  });

  it('words every status a purchase can have, and gives any other one as it is', () => {
    for (const status of purchaseStatus.enumValues) expect(statusWords(status)).not.toBe(status);
    expect(statusWords('on_hold')).toBe('on_hold');
    expect(statusWords('toString')).toBe('toString');
  });
});
