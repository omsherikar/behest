import { describe, expect, it } from 'vitest';
import { purchaseStatus } from '@/lib/db/schema';
import { aboutMandate, reasonsHeading, runRefusal, statusWords, toolArgs, toolStep } from '@/lib/buyer-pages/words';

describe('reasonsHeading', () => {
  it('heads the reasons of an allowed purchase as why it was allowed, never as why it was not', () => {
    expect(reasonsHeading('ALLOW')).toBe('Why it was allowed');
    expect(reasonsHeading('ASK')).toBe('Why Behest asked you');
    expect(reasonsHeading('BLOCK')).toBe('Why it was blocked');
  });
});

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
    expect(statusWords('awaiting_approval')).toBe('Waiting for your approval');
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

describe('runRefusal', () => {
  const answer = (message: unknown) => ({ error: { message } });

  it("gives Behest's own message, as a sentence", () => {
    expect(runRefusal(429, answer('Your agent is already shopping. Wait for it to finish.'))).toBe(
      'Your agent is already shopping. Wait for it to finish.',
    );
    expect(runRefusal(429, answer('Too many requests at once. Try again in a minute.'))).toBe(
      'Too many requests at once. Try again in a minute.',
    );
    expect(runRefusal(403, answer('only the buyer persona can do this'))).toBe('Only the buyer persona can do this.');
  });

  it('words each refusal when the answer carries no message', () => {
    expect(runRefusal(400, null)).toBe('Behest could not read your request. Check it and try again.');
    expect(runRefusal(401, undefined)).toBe('Your session has ended. Pick the buyer persona on the home page.');
    expect(runRefusal(403, {})).toBe('Only the buyer can send the agent shopping. Pick the buyer persona on the home page.');
    expect(runRefusal(413, 'Payload Too Large')).toBe('Your request is too long. Keep it to 2,000 characters or fewer.');
    expect(runRefusal(429, answer(''))).toBe('Your agent is busy. Wait a minute and try again.');
    expect(runRefusal(404, answer(42))).toBe('Behest could not start your agent. Try again in a minute.');
    expect(runRefusal(500, { error: 'boom' })).toBe('Behest could not start your agent. Try again in a minute.');
    expect(runRefusal(502, answer('   '))).toBe('Behest could not start your agent. Try again in a minute.');
  });
});

describe('aboutMandate', () => {
  it('picks out a run error that is about the mandate, so the page can link to it', () => {
    expect(aboutMandate('Sign a mandate first.')).toBe(true);
    expect(aboutMandate('Your Mandate has ended. Sign a new one.')).toBe(true);
    expect(aboutMandate('Your agent stopped because something went wrong. Check your purchases, then try again.')).toBe(false);
    expect(aboutMandate('Mandated reporting is off.')).toBe(false);
  });
});

describe('toolArgs', () => {
  it('writes each argument the agent chose', () => {
    expect(toolArgs({ query: 'turmeric', maxPriceCents: 2500 })).toBe('query: "turmeric", maxPriceCents: 2500');
  });

  it('writes the cart of a proposal as SKUs and quantities', () => {
    const input = { sellerSlug: 'ravi-spices', items: [{ sku: 'TUR-100', quantity: 2 }, { sku: 'CUM-100', quantity: 1 }] };
    expect(toolArgs(input)).toBe('sellerSlug: "ravi-spices", items: TUR-100 x2, CUM-100 x1');
  });

  it('cuts long text, flattens its lines and quotes it so it cannot pass for code', () => {
    const args = toolArgs({ rationale: `The buyer asked for "spices"\nfor the whole month, so I picked the cheapest jars` });
    expect(args).toBe(`rationale: "The buyer asked for \\"spices\\" for the whole mo..."`);
  });

  it('leaves out what it cannot write plainly', () => {
    expect(toolArgs({ filter: { nested: true }, items: [1, 2], ok: true })).toBe('items: 2 items, ok: true');
    expect(toolArgs('turmeric')).toBe('');
    expect(toolArgs(null)).toBe('');
  });
});
