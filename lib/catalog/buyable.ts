import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { products } from '@/lib/db/schema';

// What an agent can buy: no listing flagged as text aimed at AI agents, and nothing sold out. The
// public seller catalog route and the shopping agent's tools both list products by this rule, so
// they offer agents the same products.

/**
 * A product that can be bought: its listing carries no flag, and it is in stock or its seller does
 * not track its stock. A condition to add to any query on products.
 */
export const buyable = sql`(cardinality(${products.flags}) = 0 and (${products.stock} is null or ${products.stock} > 0))`;

/** A seller's products that can be bought, in SKU order. */
export async function buyableProducts(db: Db, sellerId: string): Promise<(typeof products.$inferSelect)[]> {
  return db
    .select()
    .from(products)
    .where(and(eq(products.sellerId, sellerId), buyable))
    .orderBy(asc(products.sku));
}
