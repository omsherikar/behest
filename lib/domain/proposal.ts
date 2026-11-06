import { z } from 'zod';

// What the shopping agent asks to buy: SKUs and quantities at one seller, nothing more.
// Prices, titles and categories are never taken from the agent; the gate rebuilds the cart
// from the catalog. The rationale is the agent's own claim and is treated as unverified.

export const PurchaseProposal = z
  .object({
    sellerSlug: z.string().min(1),
    items: z
      .array(
        z
          .object({
            sku: z.string().min(1),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(20)
      // One line per SKU, so the gate's per-SKU quantity and stock rules see the full quantity.
      .refine((items) => new Set(items.map((i) => i.sku)).size === items.length, {
        message: 'each SKU may appear only once',
      }),
    rationale: z.string().max(1000),
  })
  .strict();
export type PurchaseProposal = z.infer<typeof PurchaseProposal>;
