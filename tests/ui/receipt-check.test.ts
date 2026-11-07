import { describe, expect, it, vi } from 'vitest';
import type { Cart } from '@/lib/domain/cart';
import { checkReceipt, rejectionWords, VERIFY_ENDPOINT } from '@/lib/ui/receipt-check';

const cart: Cart = {
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [{ sku: 'TUR-100', title: 'Turmeric, 100 g', category: 'spices', unitPriceCents: 450, quantity: 2 }],
  totalCents: 900,
};
const request = { jws: 'h.p.s', cart, sellerSlug: 'ravi-spices' };
const answer = (status: number, body: unknown) => vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe('checkReceipt', () => {
  it('asks the verifier in audit mode with the receipt, the cart and the seller', async () => {
    const fetchFn = answer(200, { ok: true, payload: { id: 'rct-1' } });
    await checkReceipt(request, fetchFn);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VERIFY_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ...request, mode: 'audit' });
  });

  it('reports a receipt the verifier accepts', async () => {
    expect(await checkReceipt(request, answer(200, { ok: true, payload: { id: 'rct-1' } }))).toEqual({ state: 'verified', receiptId: 'rct-1' });
  });

  it('says in words why a receipt was refused', async () => {
    expect(await checkReceipt(request, answer(200, { ok: false, reason: 'cart_mismatch' }))).toEqual({
      state: 'rejected',
      reason: 'The cart does not match the receipt.',
    });
  });

  it('says when the verifier could not answer', async () => {
    expect((await checkReceipt(request, answer(429, { error: { message: 'Too many' } }))).state).toBe('unavailable');
    expect((await checkReceipt(request, answer(500, null))).state).toBe('unavailable');
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    expect(await checkReceipt(request, offline)).toMatchObject({ state: 'unavailable' });
  });
});

describe('rejectionWords', () => {
  it('words every reason the verifier gives, and anything else plainly', () => {
    for (const reason of ['bad_signature', 'malformed', 'expired', 'wrong_seller', 'cart_mismatch', 'amount_mismatch', 'replayed']) {
      expect(rejectionWords(reason)).toMatch(/^[A-Z].*\.$/);
    }
    expect(rejectionWords('something_new')).toBe('The verifier refused the receipt.');
  });
});
