import { and, eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { purchaseEvents, purchases } from '@/lib/db/schema';
import { assertTransition, type PurchaseStatus } from './transitions';

// A purchase's event log, the record a dispute's evidence pack is built from. Rows are only ever
// appended. Every status change is written by `transition`, which logs it as a `status` event with
// `{ from, to }` in the same transaction; every other step (gate, intent, charge, capture, ...)
// is logged under its own kind with `appendEvent`.

/** Appends one event to a purchase's log. */
export async function appendEvent(db: Db, purchaseId: string, kind: string, data: Record<string, unknown>): Promise<void> {
  await db.insert(purchaseEvents).values({ purchaseId, kind, data });
}

/** Columns that may change together with a purchase's status, such as the PayPal ids of a capture. */
export type PurchaseChanges = Omit<Partial<typeof purchases.$inferInsert>, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

/** The purchase was not in the status the caller expected: something else moved it first, or it does not exist. */
export class StaleTransition extends Error {
  constructor(
    readonly purchaseId: string,
    readonly from: PurchaseStatus,
    readonly to: PurchaseStatus,
  ) {
    super(`purchase ${purchaseId} is not ${from}, so it was not moved to ${to}`);
    this.name = 'StaleTransition';
  }
}

/**
 * Moves a purchase from `from` to `to`, setting `changes` in the same update, and logs the move as
 * a `status` event in the same transaction. Throws IllegalTransition, before touching the database,
 * if the lifecycle does not allow the move, and StaleTransition, changing nothing, if the purchase
 * is no longer in `from`. Of two concurrent moves from the same status, exactly one succeeds.
 * Inside a caller's transaction it commits or rolls back with that transaction.
 */
export async function transition(
  db: Db,
  purchaseId: string,
  from: PurchaseStatus,
  to: PurchaseStatus,
  changes: PurchaseChanges = {},
): Promise<void> {
  assertTransition(from, to);
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(purchases)
      .set({ ...changes, status: to })
      .where(and(eq(purchases.id, purchaseId), eq(purchases.status, from)))
      .returning({ id: purchases.id });
    if (moved.length === 0) throw new StaleTransition(purchaseId, from, to);
    await appendEvent(tx, purchaseId, 'status', { from, to });
  });
}
