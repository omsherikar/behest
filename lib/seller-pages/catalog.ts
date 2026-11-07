import { asc, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { products } from '@/lib/db/schema';
import { categoryLabel } from '@/lib/domain/categories';

// The seller catalog page: the seller's listings with their prices, stock and market benchmark, and
// for each listing that screening flagged, that it is hidden from agents and why. A flagged listing
// is left out of the shopping agent's search and blocked by the policy gate, so no agent buys it.

export type CatalogRow = {
  id: string;
  sku: string;
  title: string;
  /** The category as a person reads it, such as "personal care". */
  category: string;
  priceCents: number;
  /** Units on hand, or null when the seller does not track stock. */
  stock: number | null;
  /** The market median unit price, or null when no benchmark was found. */
  marketMedianCents: number | null;
  /** Why the listing is hidden from agents, or null when it is not. */
  hiddenReason: string | null;
};

const FLAG_REASONS: Record<string, string> = {
  agent_instructions: 'Its text speaks to AI agents',
};

/** Why a listing with `flags` is hidden from agents, in words, or null when it has none. */
export function hiddenReason(flags: string[]): string | null {
  if (flags.length === 0) return null;
  const reasons = flags.map((flag) => (Object.hasOwn(FLAG_REASONS, flag) ? FLAG_REASONS[flag] : flag.replaceAll('_', ' ')));
  const text = reasons.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The seller's products by SKU, as the page shows them. */
export async function sellerCatalogRows(db: Db, sellerId: string): Promise<CatalogRow[]> {
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      title: products.title,
      category: products.category,
      priceCents: products.priceCents,
      stock: products.stock,
      marketMedianCents: products.marketMedianCents,
      flags: products.flags,
    })
    .from(products)
    .where(eq(products.sellerId, sellerId))
    .orderBy(asc(products.sku));
  return rows.map(({ flags, category, ...row }) => ({
    ...row,
    category: categoryLabel(category),
    hiddenReason: hiddenReason(flags),
  }));
}
