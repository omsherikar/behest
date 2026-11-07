import { count, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import { sellerCatalogRows } from './catalog';

// Which seller the seller pages show, and the summary on the shop page once it is onboarded.

export type SellerRef = { id: string; slug: string; name: string };

export type SellerSummary = SellerRef & {
  payoutEmail: string;
  listings: number;
  /** The listings hidden from agents, by SKU, with why. */
  hidden: { sku: string; title: string; reason: string }[];
  orders: { accepted: number; rejected: number };
};

/** The seller with `slug`, or null when no seller has it. */
export async function findSeller(db: Db, slug: string): Promise<SellerRef | null> {
  const [seller] = await db
    .select({ id: sellers.id, slug: sellers.slug, name: sellers.name })
    .from(sellers)
    .where(eq(sellers.slug, slug));
  return seller ?? null;
}

/** The shop page's summary of the seller with `slug`, or null when no seller has it. */
export async function sellerSummary(db: Db, slug: string): Promise<SellerSummary | null> {
  const [seller] = await db
    .select({ id: sellers.id, slug: sellers.slug, name: sellers.name, payoutEmail: sellers.payoutEmail })
    .from(sellers)
    .where(eq(sellers.slug, slug));
  if (!seller) return null;

  const [catalog, orderCounts] = await Promise.all([
    sellerCatalogRows(db, seller.id),
    db
      .select({ status: sellerOrders.status, orders: count() })
      .from(sellerOrders)
      .where(eq(sellerOrders.sellerId, seller.id))
      .groupBy(sellerOrders.status),
  ]);
  const ordersWith = (status: 'accepted' | 'rejected') => orderCounts.find((row) => row.status === status)?.orders ?? 0;
  return {
    ...seller,
    listings: catalog.length,
    hidden: catalog.flatMap(({ sku, title, hiddenReason }) => (hiddenReason ? [{ sku, title, reason: hiddenReason }] : [])),
    orders: { accepted: ordersWith('accepted'), rejected: ordersWith('rejected') },
  };
}
