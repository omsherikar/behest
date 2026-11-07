import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import type { Narrative } from '@/lib/disputes/narrative';
import { MAX_NOTES_CHARS, SubmitEvidenceError, submitEvidence } from '@/lib/disputes/submit';
import { PayPalApiError } from '@/lib/paypal/http';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { setUpCaptured } from '@/tests/helpers/purchase-deps';
import { chargedDispute, INQUIRY_ACTIONS, openDispute, PAYPAL_DISPUTE_ID, paypalDispute } from '@/tests/helpers/seed-dispute';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

const APP_URL = 'https://behest.example.com';
const SUBMITTED_AT = new Date('2026-11-07T15:30:00.250Z');
const LOGGED = '[disputes] PayPal did not take the evidence:';
const NOT_READ = '[disputes] PayPal did not return the dispute:';
const EVIDENCE_PATH = `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}/provide-evidence`;

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

  it('reads the dispute live at PayPal before claiming it, and stores the stage and actions PayPal reports', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    let claimedWhenRead: unknown = 'not read';
    const read = paypal.getDispute.bind(paypal);
    vi.spyOn(paypal, 'getDispute').mockImplementation(async (id) => {
      claimedWhenRead = (await disputeRow(db, disputeId)).submittedAt;
      return read(id);
    });

    await submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('getDispute')).toEqual([[PAYPAL_DISPUTE_ID]]);
    expect(claimedWhenRead).toBeNull();
    expect(await disputeRow(db, disputeId)).toMatchObject({ stage: 'CHARGEBACK', actions: ['provide_evidence', 'accept_claim'] });
  });

  it.each([
    {
      name: 'an inquiry that allows a message',
      live: paypalDispute({ stage: 'INQUIRY', actions: INQUIRY_ACTIONS }),
      code: 'inquiry',
      message: 'PayPal takes evidence once this inquiry becomes a claim. Until then, send the buyer your answer as a message.',
    },
    {
      name: 'a dispute PayPal is reviewing, with no actions',
      live: paypalDispute({ status: 'UNDER_REVIEW', actions: [] }),
      code: 'not_taking_answers',
      message: 'PayPal is reviewing this dispute and takes no answer from Behest right now.',
    },
    {
      name: 'a dispute that allows neither evidence nor a message',
      live: paypalDispute({ status: 'WAITING_FOR_BUYER_RESPONSE', actions: ['accept_claim'] }),
      code: 'not_taking_answers',
      message: 'PayPal takes no evidence or message from Behest on this dispute right now.',
    },
    {
      name: 'a closed dispute',
      live: paypalDispute({ status: 'RESOLVED', outcome: 'RESOLVED_BUYER_FAVOUR', actions: [] }),
      code: 'closed',
      message: 'PayPal has closed this dispute, so it takes no answer from Behest.',
    },
  ])('refuses evidence for $name, storing its stage and actions and nothing else', async ({ live, code, message }) => {
    const { db, paypal, disputeId } = await chargedDispute();
    paypal.disputes = [live];

    const refused = submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(refused).rejects.toThrow(SubmitEvidenceError);
    await expect(refused).rejects.toMatchObject({ code, message });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({
      stage: live.stage,
      actions: live.actions,
      status: 'OPEN',
      narrative: null,
      submittedAt: null,
      messagedAt: null,
    });
  });

  it.each([
    ['PayPal cannot be reached', (paypal: FakePaypal) => paypal.failNext('getDispute', 'network'), TypeError],
    ['PayPal has no such dispute', (paypal: FakePaypal) => (paypal.disputes = []), PayPalApiError],
  ])('refuses without submitting when %s, logging why, so evidence never goes unchecked', async (_, fail, cause) => {
    const { db, paypal, disputeId } = await chargedDispute();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail(paypal);

    const refused = submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(refused).rejects.toMatchObject({
      code: 'check_failed',
      message: 'Could not check the dispute at PayPal. Try again.',
      cause: expect.any(cause),
    });
    expect(logged).toHaveBeenCalledWith(NOT_READ, expect.any(cause));
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ stage: null, actions: null, narrative: null, submittedAt: null });
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
    paypal.disputes = [paypalDispute()];
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
    expect(paypal.callsTo('getDispute')).toHaveLength(1);
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

  it('logs the failure and releases the submission when PayPal fails, so the operator can submit again', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('provideEvidence', 'network');

    const failed = submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(failed).rejects.toMatchObject({ code: 'paypal_failed', cause: expect.any(TypeError) });
    expect(logged).toHaveBeenCalledWith(LOGGED, expect.any(TypeError));
    expect((await disputeRow(db, disputeId)).submittedAt).toBeNull();

    const retriedAt = new Date('2026-11-07T15:31:00Z');
    await submitEvidence(depsFor(db, paypal, retriedAt), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('provideEvidence')).toHaveLength(2);
    expect((await disputeRow(db, disputeId)).submittedAt).toEqual(retriedAt);
  });

  it.each([
    [400, 'paypal_refused'],
    [422, 'paypal_refused'],
    [429, 'paypal_failed'],
    [500, 'paypal_failed'],
    [503, 'paypal_failed'],
  ] as const)('reads a PayPal %i as %s, releasing the submission', async (status, code) => {
    const { db, paypal, disputeId } = await chargedDispute();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(status, EVIDENCE_PATH, '{"name":"PAYPAL_SAYS_NO"}');
    vi.spyOn(paypal, 'provideEvidence').mockRejectedValueOnce(answer);

    await expect(submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({ code, cause: answer });
    expect((await disputeRow(db, disputeId)).submittedAt).toBeNull();
  });

  it("logs PayPal's failure before the release, and throws both errors when the release fails too", async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const paypalFailure = new TypeError('fetch failed');
    const releaseFailure = new Error('the database connection was lost');
    let loggedBeforeRelease = false;
    vi.spyOn(paypal, 'provideEvidence').mockImplementation(async () => {
      vi.spyOn(db, 'update').mockImplementation(() => {
        loggedBeforeRelease = logged.mock.calls.length > 0;
        throw releaseFailure;
      });
      throw paypalFailure;
    });

    const failed = submitEvidence(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(failed).rejects.toThrow(AggregateError);
    await expect(failed).rejects.toMatchObject({
      errors: [paypalFailure, releaseFailure],
      message: expect.stringContaining('PayPal did not take the evidence'),
    });
    expect(logged).toHaveBeenCalledWith(LOGGED, paypalFailure);
    expect(loggedBeforeRelease).toBe(true);
    vi.mocked(db.update).mockRestore();
    expect((await disputeRow(db, disputeId)).submittedAt).toEqual(SUBMITTED_AT);
  });

  it('releases only its own submission when PayPal fails', async () => {
    const { db, paypal, disputeId } = await chargedDispute();
    vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(paypal.callsTo('getDispute')).toEqual([]);
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
