import { z } from 'zod';
import { CATEGORIES } from './categories';

// A mandate's machine-readable policy. The LLM compiles plain English into this shape, the buyer
// confirms the plain-English readback, and from then on only deterministic code reads it.
// Amounts are integer cents so no rounding ever reaches a money decision.

const cents = z.number().int().nonnegative();
const category = z.enum(CATEGORIES);
/**
 * A seller slug: lower-case letters, digits and hyphens, starting with a letter or digit, at most
 * 63 characters. With no commas, spaces or upper case, a list of slugs reads back unambiguously.
 */
const merchantSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const BudgetPeriod = z.enum(['day', 'week', 'month', 'once']);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

export const MandatePolicy = z
  .object({
    version: z.literal(1),
    currency: z.literal('USD'),
    /** Total the agent may spend per period. */
    budget: z.object({ amountCents: cents.positive(), period: BudgetPeriod }).strict(),
    /** Any single purchase above this is blocked outright. */
    perPurchaseMaxCents: cents.positive(),
    /** Purchases above this need the buyer's approval. Null means never ask on amount alone. */
    askAboveCents: cents.nullable(),
    categories: z
      .object({
        /** Null means any category not denied. */
        allow: z.array(category).nullable(),
        deny: z.array(category),
      })
      .strict(),
    merchants: z
      .object({
        /** Merchant slugs. Null means any merchant not denied. */
        allow: z.array(merchantSlug).nullable(),
        deny: z.array(merchantSlug),
      })
      .strict(),
    /** At most this many purchases in a rolling window. Null means no limit. */
    velocity: z
      .object({ maxPurchases: z.number().int().positive(), windowHours: z.number().int().positive() })
      .strict()
      .nullable(),
    /** ISO timestamp after which the mandate no longer authorizes anything. */
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((p) => p.perPurchaseMaxCents <= p.budget.amountCents, {
    message: 'perPurchaseMaxCents cannot exceed the budget',
    path: ['perPurchaseMaxCents'],
  })
  .refine((p) => p.askAboveCents === null || p.askAboveCents < p.perPurchaseMaxCents, {
    message: 'askAboveCents must be below perPurchaseMaxCents',
    path: ['askAboveCents'],
  })
  .refine((p) => !p.categories.allow || p.categories.allow.every((c) => !p.categories.deny.includes(c)), {
    message: 'a category cannot be both allowed and denied',
    path: ['categories'],
  });

export type MandatePolicy = z.infer<typeof MandatePolicy>;
