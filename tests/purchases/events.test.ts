import { asc, eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { purchaseEvents, purchases } from '@/lib/db/schema';
import { appendEvent, StaleTransition, transition } from '@/lib/purchases/events';
import { IllegalTransition } from '@/lib/purchases/transitions';
import { seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 30_000);

async function eventsOf(db: Db, purchaseId: string) {
  const rows = await db
    .select({ kind: purchaseEvents.kind, data: purchaseEvents.data })
    .from(purchaseEvents)
    .where(eq(purchaseEvents.purchaseId, purchaseId))
    .orderBy(asc(purchaseEvents.seq));
  return rows;
}

async function purchaseRow(db: Db, purchaseId: string) {
  const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId));
  return row;
}

it('appends events in the order they are recorded', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'proposed');

  await appendEvent(db, purchaseId, 'gate', { verdict: 'ALLOW' });
  await appendEvent(db, purchaseId, 'intent', { verdict: 'consistent', reasons: [] });

  expect(await eventsOf(db, purchaseId)).toEqual([
    { kind: 'gate', data: { verdict: 'ALLOW' } },
    { kind: 'intent', data: { verdict: 'consistent', reasons: [] } },
  ]);
});

it('moves a purchase to its next status and records the move as a status event', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'accepted');

  await transition(db, purchaseId, 'accepted', 'settled');

  expect((await purchaseRow(db, purchaseId)).status).toBe('settled');
  expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'status', data: { from: 'accepted', to: 'settled' } }]);
});

it('sets other columns in the same update as the status', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'charging');
  const capturedAt = new Date('2026-11-06T12:00:00Z');

  await transition(db, purchaseId, 'charging', 'captured', {
    paypalOrderId: 'ORDER-1',
    paypalCaptureId: 'CAPTURE-1',
    capturedAt,
  });

  expect(await purchaseRow(db, purchaseId)).toMatchObject({
    status: 'captured',
    paypalOrderId: 'ORDER-1',
    paypalCaptureId: 'CAPTURE-1',
    capturedAt,
  });
});

it('refuses a move the lifecycle does not allow, changing nothing', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'captured');

  await expect(transition(db, purchaseId, 'captured', 'settled')).rejects.toBeInstanceOf(IllegalTransition);

  expect((await purchaseRow(db, purchaseId)).status).toBe('captured');
  expect(await eventsOf(db, purchaseId)).toEqual([]);
});

it('refuses to move a purchase that is no longer in the expected status, changing nothing', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'refunded');

  const moving = transition(db, purchaseId, 'accepted', 'settled', { approveUrl: 'https://example.com/changed' });

  await expect(moving).rejects.toBeInstanceOf(StaleTransition);
  await expect(moving).rejects.toMatchObject({ purchaseId, from: 'accepted', to: 'settled' });
  expect(await purchaseRow(db, purchaseId)).toMatchObject({ status: 'refunded', approveUrl: null });
  expect(await eventsOf(db, purchaseId)).toEqual([]);
});

it('lets exactly one of two concurrent moves from the same status through', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'accepted');

  const results = await Promise.allSettled([
    transition(db, purchaseId, 'accepted', 'settled'),
    transition(db, purchaseId, 'accepted', 'refunded'),
  ]);

  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  const rejected = results.find((r) => r.status === 'rejected');
  expect(rejected?.reason).toBeInstanceOf(StaleTransition);
  const { status } = await purchaseRow(db, purchaseId);
  expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'status', data: { from: 'accepted', to: status } }]);
});

it('rolls back when the transaction it runs inside fails', async () => {
  const db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'accepted');

  const failing = db.transaction(async (tx) => {
    await transition(tx, purchaseId, 'accepted', 'settled');
    throw new Error('the caller failed after the move');
  });

  await expect(failing).rejects.toThrow('the caller failed after the move');
  expect((await purchaseRow(db, purchaseId)).status).toBe('accepted');
  expect(await eventsOf(db, purchaseId)).toEqual([]);
});
