import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import { codeWords, disputeRows, disputeView } from '@/lib/ops-pages/disputes';
import { seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

const at = (hour: number) => new Date(Date.UTC(2026, 10, 7, hour));
const PACK = {
  disputeId: 'pack-dispute',
  purchaseId: 'pack-purchase',
  items: [
    { id: 'mandate', title: 'Signed mandate', body: 'Mandate m-1.' },
    { id: 'cart', title: 'Cart', body: '- 2 x Turmeric, 100 g' },
  ],
};
const NARRATIVE = { summary: 'The buyer authorized it.', claims: [{ text: 'The buyer signed a mandate.', evidenceIds: ['mandate'] }] };

let db: Db;
const ids = { submitted: '', drafted: '', unmatched: '', refused: '' };

/**
 * Four disputes: one whose evidence was submitted, one drafted, one PayPal opened with no time that
 * is matched to no purchase, and one whose submission PayPal did not take, which keeps its narrative.
 */
beforeAll(async () => {
  db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'disputed');
  const base = { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'OPEN', amountCents: 1875 };
  const rows = await db
    .insert(disputes)
    .values([
      { ...base, paypalDisputeId: 'PP-D-1', purchaseId, openedAt: at(9), evidencePack: PACK, narrative: NARRATIVE, submittedAt: at(11) },
      { ...base, paypalDisputeId: 'PP-D-2', purchaseId, openedAt: at(10), evidencePack: PACK, buyerNotes: 'I never <b>asked</b> for this.' },
      { ...base, paypalDisputeId: 'PP-D-3', purchaseId: null, reason: 'UNAUTHORISED', status: 'UNDER_REVIEW', amountCents: 500 },
      { ...base, paypalDisputeId: 'PP-D-4', purchaseId, openedAt: at(8), evidencePack: PACK, narrative: NARRATIVE },
    ])
    .returning({ id: disputes.id });
  [ids.submitted, ids.drafted, ids.unmatched, ids.refused] = rows.map((row) => row.id);
});

describe('codeWords', () => {
  it("reads PayPal's codes as words", () => {
    expect(codeWords('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')).toBe('Merchandise or service not received');
    expect(codeWords('OPEN')).toBe('Open');
    expect(codeWords('waiting_for_seller_response')).toBe('Waiting for seller response');
    expect(codeWords('')).toBe('');
  });
});

describe('disputeRows', () => {
  it('lists every dispute, latest opened first and those with no opening time last', async () => {
    const rows = await disputeRows(db);

    expect(rows.map((row) => row.paypalDisputeId)).toEqual(['PP-D-2', 'PP-D-1', 'PP-D-4', 'PP-D-3']);
    expect(rows[1]).toEqual({
      id: ids.submitted,
      paypalDisputeId: 'PP-D-1',
      openedAt: at(9).toISOString(),
      reason: 'Merchandise or service not received',
      status: 'Open',
      amountCents: 1875,
      linked: true,
      submitted: true,
    });
    expect(rows[3]).toEqual({
      id: ids.unmatched,
      paypalDisputeId: 'PP-D-3',
      openedAt: null,
      reason: 'Unauthorised',
      status: 'Under review',
      amountCents: 500,
      linked: false,
      submitted: false,
    });
    expect(rows.map((row) => row.submitted)).toEqual([false, true, false, false]);
  });
});

describe('disputeView', () => {
  it('shows a drafted dispute with the buyer notes as written and the stored evidence items', async () => {
    const view = await disputeView(db, ids.drafted);

    expect(view).toMatchObject({
      id: ids.drafted,
      paypalDisputeId: 'PP-D-2',
      reason: 'Merchandise or service not received',
      status: 'Open',
      amountCents: 1875,
      openedAt: at(10).toISOString(),
      buyerNotes: 'I never <b>asked</b> for this.',
      linked: true,
      items: PACK.items,
      lastNarrative: null,
      submitted: null,
    });
  });

  it('shows the submitted narrative and when it was submitted', async () => {
    expect(await disputeView(db, ids.submitted)).toMatchObject({
      items: PACK.items,
      lastNarrative: null,
      submitted: { at: at(11).toISOString(), narrative: NARRATIVE },
    });
  });

  it('offers the narrative of a submission PayPal did not take, to start the next one from', async () => {
    expect(await disputeView(db, ids.refused)).toMatchObject({ lastNarrative: NARRATIVE, submitted: null });
  });

  it('shows a dispute before any draft, with no evidence items', async () => {
    expect(await disputeView(db, ids.unmatched)).toMatchObject({
      linked: false,
      openedAt: null,
      buyerNotes: null,
      items: null,
      submitted: null,
    });
  });

  it('finds nothing for an id no dispute has, or one that is not a UUID', async () => {
    expect(await disputeView(db, '0b6a3f5e-1d2c-4e8f-9a7b-3c5d6e7f8a90')).toBeNull();
    expect(await disputeView(db, 'PP-D-1')).toBeNull();
  });
});
