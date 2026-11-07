import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { products } from '@/lib/db/schema';

// What an agent can buy: one rule for every place that offers products to agents, so a listing
// flagged as text aimed at AI agents, or one that is sold out, is never offered anywhere.

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
