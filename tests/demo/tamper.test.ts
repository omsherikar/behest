import { describe, expect, it } from 'vitest';
import { Cart } from '@/lib/domain/cart';
import { cartClaims } from '@/lib/receipts/verify-receipt';
import { receiptAgeMinutes, sellerTookOrder, tamperedCart } from '@/lib/demo/tamper';

const cart: Cart = {
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [
    { sku: 'TUR-100', title: 'Lakadong Turmeric Powder 100g', category: 'spices', unitPriceCents: 450, quantity: 1 },
    { sku: 'CUM-100', title: 'Whole Cumin Seeds 100g', category: 'spices', unitPriceCents: 375, quantity: 1 },
  ],
  totalCents: 825,
};

describe('tamperedCart', () => {
  it('adds one of the first item and keeps the cart well formed', () => {
    const changed = tamperedCart(cart);
    expect(changed.items[0].quantity).toBe(2);
    expect(changed.items[1]).toEqual(cart.items[1]);
    expect(changed.totalCents).toBe(1275);
    expect(Cart.safeParse(changed).success).toBe(true);
  });

  it('gives a cart whose hash differs from the one the receipt was signed for', () => {
    expect(cartClaims(tamperedCart(cart)).hash).not.toBe(cartClaims(cart).hash);
  });

  it('leaves the original cart unchanged', () => {
    tamperedCart(cart);
    expect(cart.items[0].quantity).toBe(1);
    expect(cart.totalCents).toBe(825);
  });
});

describe('sellerTookOrder', () => {
  it('is true only once the seller has accepted the order', () => {
    expect(sellerTookOrder('accepted')).toBe(true);
    expect(sellerTookOrder('settled')).toBe(true);
    expect(sellerTookOrder('captured')).toBe(false);
    expect(sellerTookOrder('awaiting_approval')).toBe(false);
  });
});

describe('receiptAgeMinutes', () => {
  const jwsIssuedAt = (iat: number) =>
    ['e30', Buffer.from(JSON.stringify({ iat })).toString('base64url'), 'sig'].join('.');

  it('reads the age from the iat claim', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    expect(receiptAgeMinutes(jwsIssuedAt(now.getTime() / 1000 - 16 * 60), now)).toBe(16);
  });

  it('is null for something that is not a receipt', () => {
    expect(receiptAgeMinutes('not-a-jws', new Date())).toBeNull();
  });
});
