import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import { codeWords, disputeRows, disputeView, stageWords } from '@/lib/ops-pages/disputes';
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
/** The links PayPal gives an inquiry waiting for the seller. */
const INQUIRY_ACTIONS = ['accept_claim', 'send_message', 'escalate', 'make_offer'];

let db: Db;
const ids = { submitted: '', drafted: '', unmatched: '', refused: '', messaged: '' };

/**
 * Five disputes: one whose evidence was submitted, one drafted, one PayPal opened with no time that
 * is matched to no purchase, one whose submission PayPal did not take, which keeps its narrative, and
 * an inquiry whose answer went to the buyer as a message.
 */
beforeAll(async () => {
  db = await createTestDb();
  const { purchaseId } = await seedPurchase(db, 'disputed');
  const base = { reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'OPEN', amountCents: 1875 };
  const rows = await db
    .insert(disputes)
    .values([
      {
        ...base,
        paypalDisputeId: 'PP-D-1',
        purchaseId,
        openedAt: at(9),
        evidencePack: PACK,
        narrative: NARRATIVE,
        submittedAt: at(11),
        stage: 'CHARGEBACK',
        actions: [],
      },
      {
        ...base,
        paypalDisputeId: 'PP-D-2',
        purchaseId,
        openedAt: at(10),
        evidencePack: PACK,
        buyerNotes: 'I never <b>asked</b> for this.',
        stage: 'INQUIRY',
        actions: INQUIRY_ACTIONS,
      },
      { ...base, paypalDisputeId: 'PP-D-3', purchaseId: null, reason: 'UNAUTHORISED', status: 'UNDER_REVIEW', amountCents: 500 },
      { ...base, paypalDisputeId: 'PP-D-4', purchaseId, openedAt: at(8), evidencePack: PACK, narrative: NARRATIVE },
      {
        ...base,
        paypalDisputeId: 'PP-D-5',
        purchaseId,
        openedAt: at(7),
        evidencePack: PACK,
        narrative: NARRATIVE,
        messagedAt: at(12),
        stage: 'INQUIRY',
        actions: INQUIRY_ACTIONS,
      },
    ])
    .returning({ id: disputes.id });
  [ids.submitted, ids.drafted, ids.unmatched, ids.refused, ids.messaged] = rows.map((row) => row.id);
});

describe('codeWords', () => {
  it("reads PayPal's codes as words", () => {
    expect(codeWords('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')).toBe('Merchandise or service not received');
    expect(codeWords('OPEN')).toBe('Open');
    expect(codeWords('waiting_for_seller_response')).toBe('Waiting for seller response');
    expect(codeWords('')).toBe('');
  });
});

describe('stageWords', () => {
  it("reads PayPal's stages as words, and keeps a stage it does not know as given", () => {
    expect(stageWords('INQUIRY')).toBe('Inquiry');
    expect(stageWords('CHARGEBACK')).toBe('Chargeback');
    expect(stageWords('PRE_ARBITRATION')).toBe('Pre-arbitration');
    expect(stageWords('ARBITRATION')).toBe('Arbitration');
    expect(stageWords('SOME_NEW_STAGE')).toBe('SOME_NEW_STAGE');
  });
});

describe('disputeRows', () => {
  it('lists every dispute, latest opened first and those with no opening time last', async () => {
    const rows = await disputeRows(db);

    expect(rows.map((row) => row.paypalDisputeId)).toEqual(['PP-D-2', 'PP-D-1', 'PP-D-4', 'PP-D-5', 'PP-D-3']);
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
    expect(rows[4]).toEqual({
      id: ids.unmatched,
      paypalDisputeId: 'PP-D-3',
      openedAt: null,
      reason: 'Unauthorised',
      status: 'Under review',
      amountCents: 500,
      linked: false,
      submitted: false,
    });
    expect(rows.map((row) => row.submitted)).toEqual([false, true, false, false, false]);
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
      stage: 'Inquiry',
      actions: INQUIRY_ACTIONS,
      messagedAt: null,
      items: PACK.items,
      lastNarrative: null,
      submitted: null,
    });
  });

  it('shows when the answer went to the buyer as a message, and offers that narrative to submit as evidence later', async () => {
    expect(await disputeView(db, ids.messaged)).toMatchObject({
      stage: 'Inquiry',
      actions: INQUIRY_ACTIONS,
      messagedAt: at(12).toISOString(),
      lastNarrative: NARRATIVE,
      submitted: null,
    });
  });

  it('shows the submitted narrative and when it was submitted', async () => {
    expect(await disputeView(db, ids.submitted)).toMatchObject({
      items: PACK.items,
      lastNarrative: null,
      submitted: { at: at(11).toISOString(), narrative: NARRATIVE },
      stage: 'Chargeback',
      actions: [],
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
      stage: null,
      actions: null,
      messagedAt: null,
      items: null,
      submitted: null,
    });
  });

  it('finds nothing for an id no dispute has, or one that is not a UUID', async () => {
    expect(await disputeView(db, '0b6a3f5e-1d2c-4e8f-9a7b-3c5d6e7f8a90')).toBeNull();
    expect(await disputeView(db, 'PP-D-1')).toBeNull();
  });
});
