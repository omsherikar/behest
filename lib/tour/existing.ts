import { inArray } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes, purchases, sellerOrders } from '@/lib/db/schema';
import type { TourPins } from './pins';

// The pins whose records are still there. A demo reset removes every purchase, order and dispute,
// so a pin can outlive its record; read as no pin, it makes the step say the demo data is not
// loaded instead of opening an empty panel or a page that cannot be found. Server only: it reads
// the database, which lib/tour/pins.ts, also used in the browser, must not.

export async function pinsThatExist(db: Db, pins: TourPins): Promise<TourPins> {
  const purchaseIds = [pins.allowed, pins.held, pins.blocked].filter((id): id is string => id !== null);
  const [foundPurchases, foundOrders, foundDisputes] = await Promise.all([
    purchaseIds.length > 0 ? db.select({ id: purchases.id }).from(purchases).where(inArray(purchases.id, purchaseIds)) : [],
    pins.order ? db.select({ id: sellerOrders.id }).from(sellerOrders).where(inArray(sellerOrders.id, [pins.order])) : [],
    pins.dispute ? db.select({ id: disputes.id }).from(disputes).where(inArray(disputes.id, [pins.dispute])) : [],
  ]);
  const kept = (id: string | null, rows: { id: string }[]) => (id !== null && rows.some((row) => row.id === id) ? id : null);
  return {
    allowed: kept(pins.allowed, foundPurchases),
    held: kept(pins.held, foundPurchases),
    blocked: kept(pins.blocked, foundPurchases),
    order: kept(pins.order, foundOrders),
    dispute: kept(pins.dispute, foundDisputes),
  };
}
