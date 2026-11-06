import { expect, it } from 'vitest';
import { Cart } from '@/lib/domain/cart';

const cart = (totalCents: number) => ({
  seller: { slug: 'ravi-spices', name: 'Ravi Spices' },
  currency: 'USD',
  items: [
    { sku: 'TUR-100', title: 'Turmeric 100g', category: 'spices', unitPriceCents: 450, quantity: 2 },
    { sku: 'CUM-100', title: 'Cumin 100g', category: 'spices', unitPriceCents: 375, quantity: 1 },
  ],
  totalCents,
});

it('rejects a cart whose total is not the sum of its items', () => {
  expect(Cart.safeParse(cart(1300)).success).toBe(false);
  expect(Cart.safeParse(cart(1275)).success).toBe(true);
});

it('rejects fields outside the cart contract', () => {
  const { seller, ...rest } = cart(1275);
  expect(Cart.safeParse({ ...rest, merchant: seller }).success).toBe(false);
  const withUrl = cart(1275);
  withUrl.items[0] = { ...withUrl.items[0], url: 'https://example.com/tur' } as (typeof withUrl.items)[0];
  expect(Cart.safeParse(withUrl).success).toBe(false);
});
