import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import { SendMessageError, sendAnswerToBuyer } from '@/lib/disputes/message';
import type { Narrative } from '@/lib/disputes/narrative';
import { MAX_NOTES_CHARS, submitEvidence } from '@/lib/disputes/submit';
import { PayPalApiError } from '@/lib/paypal/http';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
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
const MESSAGED_AT = new Date('2026-11-07T15:30:00.250Z');
const LOGGED = '[disputes] PayPal did not take the message:';
const MESSAGE_PATH = `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}/send-message`;
/** An inquiry waiting for Behest, as the sandbox read one: a message, but no evidence yet. */
const INQUIRY = paypalDispute({ stage: 'INQUIRY', actions: INQUIRY_ACTIONS });

const NARRATIVE: Narrative = {
  summary: 'The buyer authorized this purchase in a signed mandate, and Behest charged exactly the cart its signed receipt covers.',
  claims: [
    { text: 'The buyer confirmed a mandate of up to $60.00 a month on groceries and spices.', evidenceIds: ['mandate', 'readback'] },
    { text: 'Behest charged $18.75 for two jars of turmeric and one of cumin.', evidenceIds: ['cart', 'receipt'] },
  ],
};

/** The text the buyer gets for `narrative` on a purchase with the receipt `receiptId`: the evidence notes. */
function messageFor(narrative: Narrative, receiptId: string): string {
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

function depsFor(db: Db, paypal: FakePaypal, now = MESSAGED_AT) {
  return { db, paypal, now: () => now, appUrl: APP_URL };
}

/** A charged purchase under a dispute PayPal reads as an inquiry. */
async function inquiry() {
  const s = await chargedDispute();
  s.paypal.disputes = [INQUIRY];
  return s;
}

describe('sendAnswerToBuyer', () => {
  it('sends the buyer the narrative as the evidence notes would read, with the receipt id and verification URL', async () => {
    const { db, paypal, purchaseId, disputeId } = await inquiry();

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('sendDisputeMessage')).toEqual([[PAYPAL_DISPUTE_ID, messageFor(NARRATIVE, await receiptIdOf(db, purchaseId))]]);
  });

  it('reads the dispute live first, and stores the stage and actions PayPal reports', async () => {
    const { db, paypal, disputeId } = await inquiry();

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('getDispute')).toEqual([[PAYPAL_DISPUTE_ID]]);
    expect(paypal.calls.map((call) => call.method).slice(-2)).toEqual(['getDispute', 'sendDisputeMessage']);
    expect(await disputeRow(db, disputeId)).toMatchObject({ stage: 'INQUIRY', actions: INQUIRY_ACTIONS });
  });

  it('stores the narrative and the time of the message, and returns that time, leaving the evidence unsubmitted', async () => {
    const { db, paypal, disputeId } = await inquiry();

    expect(await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).toEqual(MESSAGED_AT);

    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: NARRATIVE, messagedAt: MESSAGED_AT, submittedAt: null });
  });

  it('records nothing until PayPal has taken the message', async () => {
    const { db, paypal, disputeId } = await inquiry();
    let seen: unknown = 'not sent';
    vi.spyOn(paypal, 'sendDisputeMessage').mockImplementation(async () => {
      seen = await disputeRow(db, disputeId);
    });

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(seen).toMatchObject({ narrative: null, messagedAt: null });
  });

  it('sends again when asked, keeping the latest narrative and time, so an edited answer can follow', async () => {
    const { db, paypal, disputeId } = await inquiry();
    const edited = { ...NARRATIVE, summary: 'The buyer authorized this purchase.' };
    const later = new Date('2026-11-07T16:00:00Z');

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });
    await sendAnswerToBuyer(depsFor(db, paypal, later), { disputeId, narrative: edited });

    expect(paypal.callsTo('sendDisputeMessage')).toHaveLength(2);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: edited, messagedAt: later, submittedAt: null });
  });

  it('leaves the evidence to submit once PayPal makes the inquiry a claim', async () => {
    const { db, paypal, disputeId } = await inquiry();
    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });
    paypal.disputes = [paypalDispute()];
    const submittedAt = new Date('2026-11-09T10:00:00Z');

    await submitEvidence(depsFor(db, paypal, submittedAt), { disputeId, narrative: NARRATIVE });

    expect(paypal.callsTo('provideEvidence')).toHaveLength(1);
    expect(await disputeRow(db, disputeId)).toMatchObject({ submittedAt, messagedAt: MESSAGED_AT, stage: 'CHARGEBACK' });
  });

  it('never replaces the narrative of evidence submitted while the message was on its way', async () => {
    const { db, paypal, disputeId } = await inquiry();
    const submitted = { ...NARRATIVE, summary: 'The submitted summary.' };
    const submittedAt = new Date('2026-11-07T15:30:01Z');
    vi.spyOn(paypal, 'sendDisputeMessage').mockImplementation(async () => {
      await db.update(disputes).set({ narrative: submitted, submittedAt }).where(eq(disputes.id, disputeId));
    });

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: submitted, submittedAt, messagedAt: MESSAGED_AT });
  });

  it('leaves the receipt lines out for a purchase that was never given a receipt', async () => {
    const { db, paypal, purchaseId, disputeId } = await inquiry();
    await db.delete(receipts).where(eq(receipts.purchaseId, purchaseId));

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    const [[, message]] = paypal.callsTo('sendDisputeMessage');
    expect(message).toBe(messageFor(NARRATIVE, 'none').split('\n').slice(0, -3).join('\n'));
  });

  it.each([
    {
      name: 'a claim, which takes evidence instead',
      live: paypalDispute({ actions: ['provide_evidence', 'accept_claim'] }),
      code: 'claim',
      message: 'PayPal takes evidence on this dispute now, not a message. Submit the evidence to PayPal instead.',
    },
    {
      name: 'a dispute PayPal is reviewing, with no actions',
      live: paypalDispute({ status: 'UNDER_REVIEW', actions: [] }),
      code: 'not_taking_answers',
      message: 'PayPal is reviewing this dispute and takes no answer from Behest right now.',
    },
    {
      name: 'a closed dispute',
      live: paypalDispute({ status: 'RESOLVED', outcome: 'RESOLVED_SELLER_FAVOUR', actions: [] }),
      code: 'closed',
      message: 'PayPal has closed this dispute, so it takes no answer from Behest.',
    },
  ])('refuses a message on $name, storing its stage and actions and nothing else', async ({ live, code, message }) => {
    const { db, paypal, disputeId } = await chargedDispute();
    paypal.disputes = [live];

    const refused = sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(refused).rejects.toThrow(SendMessageError);
    await expect(refused).rejects.toMatchObject({ code, message });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({
      stage: live.stage,
      actions: live.actions,
      narrative: null,
      messagedAt: null,
      submittedAt: null,
    });
  });

  it.each([
    ['PayPal cannot be reached', (paypal: FakePaypal) => paypal.failNext('getDispute', 'network'), TypeError],
    ['PayPal has no such dispute', (paypal: FakePaypal) => (paypal.disputes = []), PayPalApiError],
  ])('refuses without sending when %s, logging why, so no message goes unchecked', async (_, fail, cause) => {
    const { db, paypal, disputeId } = await inquiry();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail(paypal);

    const refused = sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    await expect(refused).rejects.toMatchObject({
      code: 'check_failed',
      message: 'Could not check the dispute at PayPal. Try again.',
      cause: expect.any(cause),
    });
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not return the dispute:', expect.any(cause));
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ stage: null, actions: null, narrative: null, messagedAt: null });
  });

  it.each([
    [400, 'paypal_refused'],
    [422, 'paypal_refused'],
    [429, 'paypal_failed'],
    [503, 'paypal_failed'],
  ] as const)("reads a PayPal %i as %s, logging PayPal's error and recording nothing", async (status, code) => {
    const { db, paypal, disputeId } = await inquiry();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(status, MESSAGE_PATH, '{"name":"PAYPAL_SAYS_NO"}');
    vi.spyOn(paypal, 'sendDisputeMessage').mockRejectedValueOnce(answer);

    await expect(sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({ code, cause: answer });
    expect(logged).toHaveBeenCalledWith(LOGGED, answer);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: null, messagedAt: null });
  });

  it('reads a lost connection as paypal_failed, and a second try sends the same text', async () => {
    const { db, paypal, disputeId } = await inquiry();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('sendDisputeMessage', 'network');

    await expect(sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'paypal_failed',
      cause: expect.any(TypeError),
    });
    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE });

    const [first, second] = paypal.callsTo('sendDisputeMessage');
    expect(second).toEqual(first);
    expect((await disputeRow(db, disputeId)).messagedAt).toEqual(MESSAGED_AT);
  });

  it(`sends a message of exactly ${MAX_NOTES_CHARS} characters, PayPal's limit`, async () => {
    const { db, paypal, purchaseId, disputeId } = await inquiry();
    const padding = MAX_NOTES_CHARS - messageFor({ ...NARRATIVE, summary: '' }, await receiptIdOf(db, purchaseId)).length;

    await sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: { ...NARRATIVE, summary: 'a'.repeat(padding) } });

    expect(paypal.callsTo('sendDisputeMessage')[0][1]).toHaveLength(MAX_NOTES_CHARS);
  });

  it('refuses a message over the limit and tells the operator to shorten it, reading, sending and storing nothing', async () => {
    const { db, paypal, purchaseId, disputeId } = await inquiry();
    const padding = MAX_NOTES_CHARS + 1 - messageFor({ ...NARRATIVE, summary: '' }, await receiptIdOf(db, purchaseId)).length;

    const refused = sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: { ...NARRATIVE, summary: 'a'.repeat(padding) } });

    await expect(refused).rejects.toMatchObject({
      code: 'notes_too_long',
      message: 'The message comes to 2,001 characters, and PayPal takes at most 2,000. Shorten the summary or the claims and send it again.',
    });
    expect(paypal.callsTo('getDispute')).toEqual([]);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: null, messagedAt: null });
  });

  it('refuses a dispute whose evidence was already submitted, reading and sending nothing', async () => {
    const { db, paypal, disputeId } = await inquiry();
    const submittedAt = new Date('2026-11-07T15:00:00Z');
    await db.update(disputes).set({ narrative: NARRATIVE, submittedAt }).where(eq(disputes.id, disputeId));

    await expect(sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'already_submitted',
    });
    expect(paypal.callsTo('getDispute')).toEqual([]);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ messagedAt: null, submittedAt });
  });

  it('refuses a dispute that does not exist', async () => {
    const { db, paypal } = await inquiry();

    await expect(sendAnswerToBuyer(depsFor(db, paypal), { disputeId: crypto.randomUUID(), narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'unknown_dispute',
    });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
  });

  it('refuses a dispute not matched to a purchase, reading, sending and storing nothing', async () => {
    const { db, paypal } = await inquiry();
    await db.delete(disputes);
    const disputeId = await openDispute(db, null);

    await expect(sendAnswerToBuyer(depsFor(db, paypal), { disputeId, narrative: NARRATIVE })).rejects.toMatchObject({
      code: 'unmatched',
    });
    expect(paypal.callsTo('getDispute')).toEqual([]);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(db, disputeId)).toMatchObject({ narrative: null, messagedAt: null });
  });
});
