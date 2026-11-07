import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import type { Narrative } from '@/lib/disputes/narrative';
import { MAX_NOTES_CHARS, SubmitEvidenceError, submitEvidence } from '@/lib/disputes/submit';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { setUpCaptured } from '@/tests/helpers/purchase-deps';
import { chargedDispute, openDispute, PAYPAL_DISPUTE_ID } from '@/tests/helpers/seed-dispute';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const APP_URL = 'https://behest.example.com';
const SUBMITTED_AT = new Date('2026-11-07T15:30:00.250Z');

const NARRATIVE: Narrative = {
  summary: 'The buyer authorized this purchase in a signed mandate, and Behest charged exactly the cart its signed receipt covers.',
  claims: [
    { text: 'The buyer confirmed a mandate of up to $60.00 a month on groceries and spices.', evidenceIds: ['mandate', 'readback'] },
    { text: 'Behest charged $18.75 for two jars of turmeric and one of cumin.', evidenceIds: ['cart', 'receipt'] },
  ],
};

/** The notes sent for `narrative` on a purchase with the receipt `receiptId`. */
function notesFor(narrative: Narrative, receiptId: string): string {
  return [
    narrative.summary,
    '',
    'Claims, with the evidence items that show each:',
    ...narrative.claims.map((claim, index) => `${index + 1}. ${claim.text} ${claim.evidenceIds.map((id) => `[${id}]`).join(' ')}`),
    '',
    `Signed receipt: ${receiptId}`,
    `Verify it at: ${APP_URL}/api/receipts/verify`,
  ].join('\n');
}

async function receiptIdOf(db: Db, purchaseId: string): Promise<string> {
  const [receipt] = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.purchaseId, purchaseId));
  return receipt.id;
}

async function disputeRow(db: Db, disputeId: string) {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  return row;
}

function depsFor(db: Db, paypal: FakePaypal, now = SUBMITTED_AT) {
  return { db, paypal, now: () => now, appUrl: APP_URL };
}

describe('submitEvidence', () => {
  it('sends PayPal the summary, each claim with its citations, the receipt id and the verification URL as notes', async () => {
    const { db, paypal, purchaseId, disputeId } = await chargedDispute();

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    const receiptId = await receiptIdOf(db, purchaseId);
    expect(paypal.callsTo('provideEvidence')).toEqual([[PAYPAL_DISPUTE_ID, { notes: notesFor(NARRATIVE, receiptId) }]]);
    const { notes } = paypal.callsTo('provideEvidence')[0][1];
    expect(notes).toContain('[mandate] [readback]');
    expect(notes).toContain(receiptId);
    expect(notes).toContain('https://behest.example.com/api/receipts/verify');
  });

  it('stores the narrative and the submission time', async () => {
    const { db, paypal, disputeId } = await chargedDispute();

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: NARRATIVE, submittedAt: SUBMITTED_AT });
  });

  it('has the submission stored before PayPal is asked, with no transaction left open', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    let seen: unknown;
    vi.spyOn(paypal, 'provideEvidence').mockImplementation(async () => {
      seen = (await disputeRow(db, disputeId)).submittedAt;
    });

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(seen).toEqual(SUBMITTED_AT);
  });

  it('writes the summary and each claim on one line, with every run of spaces or line breaks made one space', async () => {
    const { db, paypal, purchaseId, disputeId } = await chargedDispute();
    const narrative: Narrative = {
      summary: '  The buyer\nauthorized\r\nthis purchase. ',
      claims: [{ text: 'The mandate allows\u0085spices\t and groceries.\n', evidenceIds: ['mandate'] }],
    };

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative });

    const flat: Narrative = {
      summary: 'The buyer authorized this purchase.',
      claims: [{ text: 'The mandate allows spices and groceries.', evidenceIds: ['mandate'] }],
    };
    expect(paypal.callsTo('provideEvidence')[0][1].notes).toBe(notesFor(flat, await receiptIdOf(db, purchaseId)));
    // The narrative is stored as the operator sent it.
    expect((await disputeRow(db, disputeId)).narrative).toEqual(narrative);
  });

  it('leaves the receipt lines out for a purchase that was never given a receipt', async () => {
    const { db, paypal, purchaseId } = await setUpCaptured();
    const disputeId = await openDispute(db, purchaseId);

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    const { notes } = paypal.callsTo('provideEvidence')[0][1];
    expect(notes).toBe(notesFor(NARRATIVE, 'none').split('\n').slice(0, -3).join('\n'));
    expect(notes).not.toContain('receipts/verify');
  });

  it('refuses a second submission with already submitted, sending and storing nothing more', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    const second = submitEvidence(depsFor(db, paypal, new Date('2026-11-07T16:00:00Z')), {
      disputeId,
      narrative: { ...NARRATIVE, summary: 'Another summary.' },
    });

    await expect(second).rejects.toThrow(new SubmitEvidenceError('already_submitted', 'already submitted'));
    await expect(second).rejects.toMatchObject({ code: 'already_submitted' });
    expect(paypal.callsTo('provideEvidence')).toHaveLength(1);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: NARRATIVE, submittedAt: SUBMITTED_AT });
  });

  it('sends one of two submissions made at once and refuses the other as already submitted', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    // PayPal holds the first submission until the other has finished or has reached PayPal too, so
    // both are in flight together.
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    let sent = 0;
    vi.spyOn(paypal, 'provideEvidence').mockImplementation(async () => {
      if (++sent === 2) answer();
      await answered;
    });

    const outcomes = [NARRATIVE, { ...NARRATIVE, summary: 'Another summary.' }].map((narrative) =>
      submitEvidence(depsFor(db, paypal), { disputeId, narrative }).then(
        () => 'sent',
        (failure: Error) => failure.message,
      ),
    );
    await Promise.race(outcomes);
    answer();

    expect((await Promise.all(outcomes)).sort()).toEqual(['already submitted', 'sent']);
    expect(sent).toBe(1);
  });

  it('releases the submission when PayPal fails, so the operator can submit again', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    paypal.failNext('provideEvidence', 'network');

    const failed = submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(failed).rejects.toMatchObject({ code: 'paypal_failed', cause: expect.any(TypeError) });
    expect((await disputeRow(db, disputeId)).submittedAt).toBeNull();

    const retriedAt = new Date('2026-11-07T15:31:00Z');
    await submitEvidence(depsFor(db, paypal, retriedAt), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('provideEvidence')).toHaveLength(2);
    expect((await disputeRow(db, disputeId)).submittedAt).toEqual(retriedAt);
  });

  it('releases only its own submission when PayPal fails', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    const otherAt = new Date('2026-11-07T15:30:05Z');
    vi.spyOn(paypal, 'provideEvidence').mockImplementation(async () => {
      await db.update(disputes).set({ submittedAt: otherAt }).where(eq(disputes.id, disputeId));
      throw new TypeError('fetch failed');
    });

    await expect(submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'paypal_failed',
    });

    expect((await disputeRow(db, disputeId)).submittedAt).toEqual(otherAt);
  });

  it(`sends notes of exactly ${MAX_NOTES_CHARS} characters, PayPal's limit`, async () => {
    const { db, paypal, purchaseId, disputeId } = await chargedDispute();
    const receiptId = await receiptIdOf(db, purchaseId);
    const padding = MAX_NOTES_CHARS - notesFor({ ...NARRATIVE, summary: '' }, receiptId).length;
    const narrative = { ...NARRATIVE, summary: 'a'.repeat(padding) };

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative });

    expect(paypal.callsTo('provideEvidence')[0][1].notes).toHaveLength(MAX_NOTES_CHARS);
  });

  it('refuses notes over the limit and tells the operator to shorten them, storing and sending nothing', async () => {
    const { db, paypal, purchaseId, disputeId } = await chargedDispute();
    const receiptId = await receiptIdOf(db, purchaseId);
    const padding = MAX_NOTES_CHARS + 1 - notesFor({ ...NARRATIVE, summary: '' }, receiptId).length;

    const refused = submitEvidence(depsFor(db, paypal), { disputeId, narrative: { ...NARRATIVE, summary: 'a'.repeat(padding) } });

    await expect(refused).rejects.toMatchObject({
      code: 'notes_too_long',
      message:
        'The evidence notes come to 2,001 characters, and PayPal takes at most 2,000. Shorten the summary or the claims and submit again.',
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: null, submittedAt: null });
  });

  it('refuses a dispute that does not exist', async () => {
    const { db, paypal } = await chargedDispute();

    await expect(submitEvidence(depsFor(db, paypal), { disputeId: crypto.randomUUID(), narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'unknown_dispute',
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
  });

  it('refuses a dispute not matched to a purchase, storing and sending nothing', async () => {
    const { db, paypal } = await chargedDispute();
    await db.delete(disputes);
    const disputeId = await openDispute(db, null);

    await expect(submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'unmatched',
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: null, submittedAt: null });
  });
});
