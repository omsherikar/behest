import { describe, expect, it } from 'vitest';
import { draftOutcome, messageOutcome, offeredAnswer, submitOutcome } from '@/lib/ops-pages/dispute-outcomes';

const NARRATIVE = {
  summary: 'The buyer authorized this purchase.',
  claims: [{ text: 'The buyer signed a mandate.', evidenceIds: ['mandate'] }],
};

describe('submitOutcome', () => {
  it('reports a submission PayPal took, and reloads the page to show it as submitted', () => {
    expect(submitOutcome(200, { narrative: NARRATIVE })).toEqual({
      ok: true,
      message: 'The evidence was submitted to PayPal.',
      refresh: true,
    });
    expect(submitOutcome(200, null)).toEqual(submitOutcome(200, { narrative: NARRATIVE }));
    expect(submitOutcome(201, {})).toMatchObject({ ok: true });
  });

  it("shows the route's own words for a narrative it refused, as a sentence", () => {
    expect(
      submitOutcome(400, {
        error: { message: 'The evidence notes come to 2,104 characters, and PayPal takes at most 2,000. Shorten the summary or the claims and submit again.' },
      }),
    ).toEqual({
      ok: false,
      message: 'The evidence notes come to 2,104 characters, and PayPal takes at most 2,000. Shorten the summary or the claims and submit again.',
      refresh: false,
    });
    expect(submitOutcome(400, { error: { message: 'claims cite tracking, which this dispute has no item for' } })).toMatchObject({
      message: 'Claims cite tracking, which this dispute has no item for.',
    });
  });

  it('words a refused narrative itself when the route sent no message', () => {
    for (const body of [null, {}, { error: {} }, { error: { message: ' ' } }, { error: { message: 7 } }, 'Bad request']) {
      expect(submitOutcome(400, body), JSON.stringify(body)).toEqual({
        ok: false,
        message: 'Behest could not accept this narrative. Check the summary and claims, then submit again.',
        refresh: false,
      });
    }
  });

  it.each([
    [401, 'Your session has ended. Pick the operator persona on the home page, then submit again.', false],
    [403, 'Only the operator persona can submit dispute evidence. Pick it on the home page.', false],
    [404, 'Behest has no record of this dispute, so nothing was submitted.', false],
    [
      409,
      'Nothing was submitted. This dispute is not matched to a purchase, or its evidence was already submitted. The page now shows where it stands.',
      true,
    ],
    [413, 'This narrative is too large to send. Shorten the summary or the claims, then submit again.', false],
    [429, 'Too many requests in a short time. Wait a minute, then submit again.', false],
  ])('words a %i in its own plain words, whatever the route sent', (status, message, refresh) => {
    const routeText = { error: { message: 'Text from the route that this status never shows.' } };
    expect(submitOutcome(status, routeText)).toEqual({ ok: false, message, refresh });
    expect(submitOutcome(status, null)).toEqual({ ok: false, message, refresh });
  });

  it("shows the route's words when PayPal takes no evidence on the dispute now, and reloads to offer what it takes", () => {
    const message = 'PayPal takes evidence once this inquiry becomes a claim. Until then, send the buyer your answer as a message.';
    expect(submitOutcome(422, { error: { message } })).toEqual({ ok: false, message, refresh: true });
    expect(submitOutcome(422, null)).toEqual({
      ok: false,
      message: 'PayPal is not taking evidence on this dispute right now, so nothing was submitted. The page now shows what it takes.',
      refresh: true,
    });
  });

  it("shows the route's fixed words when the dispute could not be checked at PayPal", () => {
    const message = 'Could not check the dispute at PayPal. Try again.';
    expect(submitOutcome(502, { error: { message } })).toEqual({ ok: false, message, refresh: false });
  });

  it("shows the route's fixed words as given when PayPal did not take the evidence", () => {
    for (const message of ['PayPal refused the evidence; check the dispute before trying again', 'Submit it again to retry']) {
      expect(submitOutcome(502, { error: { message } })).toEqual({ ok: false, message, refresh: false });
    }
    expect(submitOutcome(502, { error: { message: '  Submit it again to retry\n' } })).toMatchObject({
      message: 'Submit it again to retry',
    });
  });

  it('words a 502 itself when the route sent no message', () => {
    for (const body of [null, {}, { error: { message: '' } }]) {
      expect(submitOutcome(502, body), JSON.stringify(body)).toEqual({
        ok: false,
        message: 'PayPal did not take the evidence, so nothing was submitted. Check the dispute, then submit again.',
        refresh: false,
      });
    }
  });

  it('says the evidence may have gone when Behest could not be reached', () => {
    expect(submitOutcome(null, null)).toEqual({
      ok: false,
      message: 'Could not reach Behest, so the evidence may not have been submitted. Reload the page to check before you submit again.',
      refresh: false,
    });
  });

  it("reloads to show where the dispute stands after a fault on Behest's side", () => {
    for (const status of [500, 503, 504, 418]) {
      expect(submitOutcome(status, { error: { message: 'Internal detail' } })).toEqual({
        ok: false,
        message: "Something went wrong on Behest's side. The page now shows whether the evidence was submitted; check it before you submit again.",
        refresh: true,
      });
    }
  });
});

describe('draftOutcome', () => {
  const ITEMS = [
    { id: 'mandate', title: 'Signed mandate', body: 'Mandate m-1.' },
    { id: 'cart', title: 'Cart', body: '- 2 x Turmeric, 100 g' },
  ];
  const drafted = { pack: { disputeId: 'd-1', purchaseId: 'p-1', items: ITEMS }, narrative: NARRATIVE };

  it("reads the pack's items and the narrative from a draft", () => {
    expect(draftOutcome(200, drafted)).toEqual({ ok: true, draft: { items: ITEMS, narrative: NARRATIVE } });
  });

  it('keeps only the fields the page shows', () => {
    const extra = {
      pack: { ...drafted.pack, items: [{ ...ITEMS[0], extra: 1 }] },
      narrative: { ...NARRATIVE, claims: [{ ...NARRATIVE.claims[0], extra: 2 }], extra: 3 },
    };
    expect(draftOutcome(200, extra)).toEqual({ ok: true, draft: { items: [ITEMS[0]], narrative: NARRATIVE } });
  });

  it('asks for a reload when a draft cannot be read, since its pack may be stored', () => {
    const message = 'Behest sent a draft this page could not read. Reload the page, then draft again.';
    for (const body of [
      null,
      'ok',
      { narrative: NARRATIVE },
      { pack: drafted.pack },
      { ...drafted, pack: { items: [{ id: 'mandate', title: 'Signed mandate' }] } },
      { ...drafted, pack: { items: 'mandate' } },
      { ...drafted, narrative: { summary: 4, claims: [] } },
      { ...drafted, narrative: { summary: 'S', claims: [{ text: 'T', evidenceIds: 'mandate' }] } },
      { ...drafted, narrative: { summary: 'S', claims: [{ text: 'T', evidenceIds: [1] }] } },
      { ...drafted, narrative: { summary: 'S', claims: [{ evidenceIds: ['mandate'] }] } },
    ]) {
      expect(draftOutcome(200, body), JSON.stringify(body)).toEqual({ ok: false, message, refresh: true });
    }
  });

  it("shows the route's fixed words for a draft the model or PayPal could not make, and reloads the stored evidence", () => {
    const message = 'The model refused to draft a narrative. Write it yourself from the evidence items, or draft again.';
    expect(draftOutcome(502, { error: { code: 'refusal', message } })).toEqual({ ok: false, message, refresh: true });
    expect(draftOutcome(502, null)).toEqual({
      ok: false,
      message: 'The draft failed. Write the narrative yourself, or draft again in a minute.',
      refresh: true,
    });
  });

  it.each([
    [401, 'Your session has ended. Pick the operator persona on the home page, then draft again.', false],
    [403, 'Only the operator persona can draft dispute evidence. Pick it on the home page.', false],
    [404, 'Behest has no record of this dispute, so nothing was drafted.', false],
    [
      409,
      'Nothing was drafted. This dispute is not matched to a purchase, or its evidence was already submitted. The page now shows where it stands.',
      true,
    ],
    [429, 'Too many drafts in a short time. Wait a minute, then draft again.', false],
    [500, "Something went wrong on Behest's side, so no draft came back. Draft again in a minute.", true],
    [null, 'Could not reach Behest. Check your connection, then draft again.', false],
  ])('words a %s in its own plain words, whatever the route sent', (status, message, refresh) => {
    expect(draftOutcome(status, { error: { message: 'Text from the route that this status never shows.' } })).toEqual({
      ok: false,
      message,
      refresh,
    });
  });
});

describe('messageOutcome', () => {
  const SENT_AT = '2026-11-08T03:10:00.000Z';

  it('reports a message PayPal took with the time it was sent, and reloads the page to show it', () => {
    expect(messageOutcome(200, { narrative: NARRATIVE, messagedAt: SENT_AT })).toEqual({ ok: true, sentAt: SENT_AT, refresh: true });
  });

  it('still reports the message as sent when the time cannot be read, for the reload to show', () => {
    for (const body of [null, {}, { messagedAt: 'yesterday' }, { messagedAt: 7 }]) {
      expect(messageOutcome(200, body), JSON.stringify(body)).toEqual({ ok: true, sentAt: null, refresh: true });
    }
  });

  it("shows the route's own words for a narrative it refused, as a sentence", () => {
    const message = 'The message comes to 2,104 characters, and PayPal takes at most 2,000. Shorten the summary or the claims and send it again.';
    expect(messageOutcome(400, { error: { message } })).toEqual({ ok: false, message, refresh: false });
    expect(messageOutcome(400, null)).toEqual({
      ok: false,
      message: 'Behest could not accept this narrative. Check the summary and claims, then send it again.',
      refresh: false,
    });
  });

  it("shows the route's words when PayPal takes no message on the dispute now, and reloads to offer what it takes", () => {
    const message = 'PayPal takes evidence on this dispute now, not a message. Submit the evidence to PayPal instead.';
    expect(messageOutcome(422, { error: { message } })).toEqual({ ok: false, message, refresh: true });
    expect(messageOutcome(422, null)).toEqual({
      ok: false,
      message: 'PayPal is not taking a message on this dispute right now, so nothing was sent. The page now shows what it takes.',
      refresh: true,
    });
  });

  it("shows the route's fixed words when PayPal did not take the message or could not be checked", () => {
    for (const message of ['PayPal did not take the message. Send it again to retry.', 'Could not check the dispute at PayPal. Try again.']) {
      expect(messageOutcome(502, { error: { message } })).toEqual({ ok: false, message, refresh: false });
    }
    expect(messageOutcome(502, null)).toEqual({
      ok: false,
      message: 'PayPal did not take the message, so nothing was sent. Check the dispute, then send it again.',
      refresh: false,
    });
  });

  it.each([
    [401, 'Your session has ended. Pick the operator persona on the home page, then send it again.', false],
    [403, 'Only the operator persona can answer a dispute. Pick it on the home page.', false],
    [404, 'Behest has no record of this dispute, so nothing was sent.', false],
    [
      409,
      'Nothing was sent. This dispute is not matched to a purchase, or its evidence was already submitted. The page now shows where it stands.',
      true,
    ],
    [413, 'This narrative is too large to send. Shorten the summary or the claims, then send it again.', false],
    [429, 'Too many messages in a short time. Wait a minute, then send it again.', false],
    [500, "Something went wrong on Behest's side. The page now shows whether the message was sent; check it before you send it again.", true],
    [null, 'Could not reach Behest, so the message may not have been sent. Reload the page to check before you send it again.', false],
  ])('words a %s in its own plain words, whatever the route sent', (status, message, refresh) => {
    const routeText = { error: { message: 'Text from the route that this status never shows.' } };
    expect(messageOutcome(status, routeText)).toEqual({ ok: false, message, refresh });
  });
});

describe('offeredAnswer', () => {
  it('offers evidence when PayPal takes it, and before PayPal has said what it allows', () => {
    expect(offeredAnswer(['provide_evidence', 'accept_claim'])).toBe('evidence');
    expect(offeredAnswer(['provide_evidence', 'send_message'])).toBe('evidence');
    expect(offeredAnswer(null)).toBe('evidence');
  });

  it('offers a message to the buyer when PayPal takes a message but no evidence', () => {
    expect(offeredAnswer(['accept_claim', 'send_message', 'escalate', 'make_offer'])).toBe('message');
  });

  it('offers nothing when PayPal takes neither', () => {
    expect(offeredAnswer([])).toBe('none');
    expect(offeredAnswer(['accept_claim', 'make_offer'])).toBe('none');
  });
});
