import { describe, expect, it } from 'vitest';
import { purchaseStatus } from '@/lib/db/schema';
import { statusWords, toolStep } from '@/lib/buyer-pages/words';

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

describe('toolStep', () => {
  it('says what the agent searched for, at Behest sellers or the market', () => {
    expect(toolStep('search_sellers', { query: 'turmeric', category: 'spices' })).toBe('Searching Behest sellers for "turmeric"');
    expect(toolStep('search_sellers', { query: '  ' })).toBe('Searching every Behest listing');
    expect(toolStep('search_market', { query: 'turmeric powder 100g' })).toBe('Checking market prices for "turmeric powder 100g"');
  });

  it('says which listing the agent read', () => {
    expect(toolStep('get_product', { sellerSlug: 'ravi-spices', sku: 'TUR-100' })).toBe('Reading listing TUR-100 at ravi-spices');
  });

  it('counts the units the agent proposed to buy and names the seller', () => {
    const input = { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 2 }, { sku: 'CUM-100', quantity: 1 }] };
    expect(toolStep('propose_purchase', input)).toBe('Proposing 3 items from ravi-spices');
    expect(toolStep('propose_purchase', { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 1 }] })).toBe(
      'Proposing 1 item from ravi-spices',
    );
  });

  it('keeps to plain words when the input is missing or not what the tool takes', () => {
    for (const input of [undefined, null, 'turmeric', [], { query: 7 }]) {
      expect(toolStep('search_sellers', input)).toBe('Searching every Behest listing');
      expect(toolStep('search_market', input)).toBe('Checking market prices');
      expect(toolStep('get_product', input)).toBe('Reading a listing');
      expect(toolStep('propose_purchase', input)).toBe('Proposing a purchase');
    }
    expect(toolStep('propose_purchase', { sellerSlug: 'ravi-spices', items: [{ quantity: 'two' }] })).toBe(
      'Proposing a purchase from ravi-spices',
    );
    expect(toolStep('check_weather', { city: 'Pune' })).toBe('Using check_weather');
  });

  it("shortens the agent's text to one line of at most 80 characters", () => {
    expect(toolStep('search_sellers', { query: 'turmeric\n\tand   cumin' })).toBe('Searching Behest sellers for "turmeric and cumin"');
    const long = 'saffron '.repeat(20);
    expect(toolStep('search_market', { query: long })).toBe(`Checking market prices for "${long.slice(0, 77).trim()}..."`);
  });
});
