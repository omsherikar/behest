import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, purchases, type PurchaseStatus } from '@/lib/db/schema';
import { syncDisputes } from '@/lib/disputes/sync';
import type { DisputeDetail } from '@/lib/paypal/port';
import { CAPTURED_AT, setUp } from '@/tests/helpers/purchase-deps';
import { eventsOf, statusOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const CAPTURE_ID = 'CAPTURE-1';

/** A dispute the buyer opened at PayPal against the seeded purchase's capture. */
function openDispute(changes: Partial<DisputeDetail> = {}): DisputeDetail {
  return {
    id: 'PP-D-1001',
    status: 'WAITING_FOR_SELLER_RESPONSE',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    amountCents: 1875,
    captureId: CAPTURE_ID,
    createTime: '2026-11-04T16:22:41.000Z',
    buyerNotes: 'My agent bought turmeric and cumin and nothing has arrived.',
    outcome: null,
    ...changes,
  };
}

/** A purchase in `status` holding PayPal's capture, and a fake PayPal reporting one dispute against it. */
async function setUpDisputed(status: PurchaseStatus, dispute: DisputeDetail = openDispute()) {
  const s = await setUp(status);
  await s.db
    .update(purchases)
    .set({ paypalOrderId: 'ORDER-1', paypalCaptureId: CAPTURE_ID, capturedAt: CAPTURED_AT })
    .where(eq(purchases.id, s.purchaseId));
  s.paypal.disputes = [dispute];
  return s;
}

async function disputeRows(db: Db) {
  return db.select().from(disputes);
}

/** The purchase's moves into `disputed`, in order. */
async function movesToDisputed(db: Db, purchaseId: string) {
  return (await eventsOf(db, purchaseId)).filter((e) => e.kind === 'status' && e.data.to === 'disputed');
}

describe('syncDisputes', () => {
  it('stores a dispute, links it to the purchase holding its capture and moves a settled purchase to disputed', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled');

    expect(await syncDisputes({ db, paypal })).toBe(1);

    expect(await disputeRows(db)).toEqual([
      expect.objectContaining({
        paypalDisputeId: 'PP-D-1001',
        purchaseId,
        captureId: CAPTURE_ID,
        status: 'WAITING_FOR_SELLER_RESPONSE',
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        amountCents: 1875,
        currency: 'USD',
        buyerNotes: 'My agent bought turmeric and cumin and nothing has arrived.',
        openedAt: new Date('2026-11-04T16:22:41.000Z'),
        evidencePack: null,
        narrative: null,
        submittedAt: null,
      }),
    ]);
    expect(await statusOf(db, purchaseId)).toBe('disputed');
    expect(await eventsOf(db, purchaseId)).toEqual([
      {
        kind: 'dispute_opened',
        data: { paypalDisputeId: 'PP-D-1001', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE' },
      },
      { kind: 'status', data: { from: 'settled', to: 'disputed' } },
    ]);
  });

  it('stores a dispute whose capture no purchase holds unlinked, and moves nothing', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled', openDispute({ captureId: 'CAPTURE-ELSEWHERE' }));

    expect(await syncDisputes({ db, paypal })).toBe(1);

    expect(await disputeRows(db)).toEqual([
      expect.objectContaining({ paypalDisputeId: 'PP-D-1001', purchaseId: null, captureId: 'CAPTURE-ELSEWHERE' }),
    ]);
    expect(await statusOf(db, purchaseId)).toBe('settled');
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('stores a dispute PayPal names no capture for unlinked', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled', openDispute({ captureId: null }));

    expect(await syncDisputes({ db, paypal })).toBe(1);

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId: null, captureId: null })]);
    expect(await statusOf(db, purchaseId)).toBe('settled');
  });

  it('moves a purchase once: a later sync updates the dispute and logs nothing more', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled');
    await syncDisputes({ db, paypal });
    const logged = await eventsOf(db, purchaseId);
    paypal.disputes = [openDispute({ status: 'UNDER_REVIEW' })];

    expect(await syncDisputes({ db, paypal })).toBe(1);

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId, status: 'UNDER_REVIEW' })]);
    expect(await statusOf(db, purchaseId)).toBe('disputed');
    expect(await eventsOf(db, purchaseId)).toEqual(logged);
  });

  it('moves a purchase once when two syncs run at the same time', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled');

    expect(await Promise.all([syncDisputes({ db, paypal }), syncDisputes({ db, paypal })])).toEqual([1, 1]);

    expect(await disputeRows(db)).toHaveLength(1);
    expect(await movesToDisputed(db, purchaseId)).toHaveLength(1);
    expect((await eventsOf(db, purchaseId)).filter((e) => e.kind === 'dispute_opened')).toHaveLength(1);
  });

  it("never changes the dispute's narrative, evidence pack or submission time", async () => {
    const { db, paypal } = await setUpDisputed('settled');
    await syncDisputes({ db, paypal });
    const operatorWork = {
      evidencePack: { disputeId: 'PP-D-1001', purchaseId: 'p', items: [{ id: 'receipt', title: 'Receipt', body: 'Signed.' }] },
      narrative: { summary: 'The buyer authorized this.', claims: [{ text: 'Signed mandate.', evidenceIds: ['mandate'] }] },
      submittedAt: new Date('2026-11-05T10:00:00Z'),
    };
    await db.update(disputes).set(operatorWork);
    paypal.disputes = [openDispute({ status: 'RESOLVED', buyerNotes: 'Arrived after all.' })];

    await syncDisputes({ db, paypal });

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ ...operatorWork, status: 'RESOLVED' })]);
  });

  it('leaves an accepted purchase accepted while its payout is out, and moves it once the payout settles it', async () => {
    // The lifecycle (ALLOWED) moves only a settled purchase into a dispute.
    const { db, paypal, purchaseId } = await setUpDisputed('accepted');

    await syncDisputes({ db, paypal });

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId })]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect((await eventsOf(db, purchaseId)).map((e) => e.kind)).toEqual(['dispute_opened']);

    await db.update(purchases).set({ status: 'settled' }).where(eq(purchases.id, purchaseId));
    await syncDisputes({ db, paypal });

    expect(await statusOf(db, purchaseId)).toBe('disputed');
    expect(await movesToDisputed(db, purchaseId)).toHaveLength(1);
  });

  it.each<PurchaseStatus>(['captured', 'refunded', 'disputed', 'resolved'])(
    'links a dispute on a %s purchase without moving it',
    async (status) => {
      const { db, paypal, purchaseId } = await setUpDisputed(status);

      await syncDisputes({ db, paypal });

      expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId })]);
      expect(await statusOf(db, purchaseId)).toBe(status);
      expect((await eventsOf(db, purchaseId)).map((e) => e.kind)).toEqual(['dispute_opened']);
    },
  );

  it('links but does not move a settled purchase for a dispute PayPal has already resolved', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled', openDispute({ status: 'RESOLVED' }));

    await syncDisputes({ db, paypal });

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId, status: 'RESOLVED' })]);
    expect(await statusOf(db, purchaseId)).toBe('settled');
  });

  it('links a dispute stored unlinked once a purchase holds its capture', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled', openDispute({ captureId: 'CAPTURE-2' }));
    await syncDisputes({ db, paypal });
    await db.update(purchases).set({ paypalCaptureId: 'CAPTURE-2' }).where(eq(purchases.id, purchaseId));

    await syncDisputes({ db, paypal });

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ purchaseId, captureId: 'CAPTURE-2' })]);
    expect(await statusOf(db, purchaseId)).toBe('disputed');
  });

  it("reads each dispute in full for its capture and the buyer's notes, which PayPal's list leaves out", async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled');
    vi.spyOn(paypal, 'listDisputes').mockResolvedValue([
      { id: 'PP-D-1001', status: 'OPEN', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', amountCents: 1875, captureId: null, createTime: '2026-11-04T16:22:41.000Z' },
    ]);

    await syncDisputes({ db, paypal });

    expect(paypal.callsTo('getDispute')).toEqual([['PP-D-1001']]);
    expect(await disputeRows(db)).toEqual([
      expect.objectContaining({ purchaseId, captureId: CAPTURE_ID, buyerNotes: openDispute().buyerNotes }),
    ]);
    expect(await statusOf(db, purchaseId)).toBe('disputed');
  });

  it('syncs every other dispute when PayPal cannot read one, then throws naming it so the sync runs again', async () => {
    const { db, paypal, purchaseId } = await setUpDisputed('settled');
    // Listed, but PayPal answers 404 when it is read by id.
    const lost = openDispute({ id: 'PP-D-GONE', captureId: null });
    vi.spyOn(paypal, 'listDisputes').mockResolvedValue([lost, openDispute()]);

    await expect(syncDisputes({ db, paypal })).rejects.toThrow('PP-D-GONE');

    expect(await disputeRows(db)).toEqual([expect.objectContaining({ paypalDisputeId: 'PP-D-1001', purchaseId })]);
    expect(await statusOf(db, purchaseId)).toBe('disputed');
  });

  it('returns 0 and stores nothing when PayPal lists no disputes', async () => {
    const { db, paypal } = await setUpDisputed('settled');
    paypal.disputes = [];

    expect(await syncDisputes({ db, paypal })).toBe(0);
    expect(await disputeRows(db)).toEqual([]);
  });
});
