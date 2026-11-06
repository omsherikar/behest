import { z } from 'zod';
import { CATEGORIES } from './categories';

// What the shopping agent proposes to buy. One cart is one purchase from one seller,
// which is also the unit the gate, the receipt and the payout work on.

export const CartItem = z
  .object({
    sku: z.string().min(1),
    title: z.string().min(1),
    category: z.enum(CATEGORIES),
    unitPriceCents: z.number().int().positive(),
    quantity: z.number().int().positive(),
  })
  .strict();
export type CartItem = z.infer<typeof CartItem>;

export const Cart = z
  .object({
    seller: z.object({ slug: z.string().min(1), name: z.string().min(1) }).strict(),
    currency: z.literal('USD'),
    items: z.array(CartItem).min(1),
    totalCents: z.number().int().positive(),
  })
  .strict()
  .refine((c) => c.totalCents === c.items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0), {
    message: 'totalCents must equal the sum of the items',
    path: ['totalCents'],
  });
export type Cart = z.infer<typeof Cart>;
