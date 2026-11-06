// The fixed category list shared by mandates, catalogs and the policy gate. The gate compares
// categories by exact match, so every product and every mandate rule must use one of these ids.
// Free-form text from a buyer or a seller is mapped onto this list by the LLM steps, never compared raw.

export const CATEGORIES = [
  'groceries',
  'spices',
  'beverages',
  'household',
  'personal_care',
  'health',
  'baby',
  'pet',
  'apparel',
  'home_decor',
  'kitchen',
  'books',
  'toys',
  'gifts',
  'electronics',
  'software',
  'travel',
  'gift_cards',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
