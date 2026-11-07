import { describe, expect, it } from 'vitest';
import { submitOutcome } from '@/lib/ops-pages/dispute-outcomes';

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
    [502, 'PayPal did not take the evidence, so nothing was submitted. Submit again to retry.', false],
  ])('words a %i in its own plain words, whatever the route sent', (status, message, refresh) => {
    const routeText = { error: { message: 'Text from the route that this status never shows.' } };
    expect(submitOutcome(status, routeText)).toEqual({ ok: false, message, refresh });
    expect(submitOutcome(status, null)).toEqual({ ok: false, message, refresh });
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
