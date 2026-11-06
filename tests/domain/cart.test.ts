import { expect, it } from 'vitest';
import { Cart } from '@/lib/domain/cart';

const turmeric = { sku: 'TUR-100', title: 'Turmeric 100g', category: 'spices', unitPriceCents: 450, quantity: 2 };
const cumin = { sku: 'CUM-100', title: 'Cumin 100g', category: 'spices', unitPriceCents: 375, quantity: 1 };

const cart = (totalCents: number, items = [turmeric, cumin]) => ({
  seller: { slug: 'ravi-spices', name: 'Ravi Spices' },
  currency: 'USD',
  items,
  totalCents,
});

it('rejects a cart whose total is not the sum of its items', () => {
  expect(Cart.safeParse(cart(1300)).success).toBe(false);
  expect(Cart.safeParse(cart(1275)).success).toBe(true);
});

it('rejects fields outside the cart contract', () => {
  const { seller, ...rest } = cart(1275);
  expect(Cart.safeParse({ ...rest, merchant: seller }).success).toBe(false);
  expect(Cart.safeParse(cart(1275, [{ ...turmeric, url: 'https://example.com/tur' } as typeof turmeric, cumin])).success).toBe(
    false,
  );
});

it('rejects a SKU split across two lines', () => {
  const result = Cart.safeParse(cart(1800, [turmeric, turmeric]));
  expect(result.success).toBe(false);
  expect(result.error?.issues).toContainEqual(
    expect.objectContaining({ path: ['items'], message: 'each SKU may appear only once' }),
  );
});
