import { describe, expect, it } from 'vitest';
import { onboardOutcome } from '@/lib/seller-pages/onboard-outcome';

const listed = (overrides: Record<string, unknown> = {}) => ({
  sellerId: '6f1c2c3e-58b1-4b8e-9d55-0e3f1b0a7c11',
  created: 6,
  flagged: 1,
  rejected: [],
  ...overrides,
});

describe('a shop that was onboarded', () => {
  it('says how many listings were made and how many are hidden from agents', () => {
    expect(onboardOutcome(201, listed())).toEqual({
      ok: true,
      headline: 'Your shop is onboarded with 6 listings.',
      flaggedNote:
        '1 listing is hidden from agents because its text speaks to AI agents. Shopping agents cannot see or buy it.',
      rejected: [],
    });
  });

  it('words one listing and several hidden listings', () => {
    const outcome = onboardOutcome(201, listed({ created: 1, flagged: 0 }));
    expect(outcome).toMatchObject({ ok: true, headline: 'Your shop is onboarded with 1 listing.', flaggedNote: null });
    expect(onboardOutcome(201, listed({ created: 4, flagged: 3 }))).toMatchObject({
      flaggedNote:
        '3 listings are hidden from agents because their text speaks to AI agents. Shopping agents cannot see or buy them.',
    });
  });

  it('lists each CSV row that could not be listed, with its line', () => {
    const outcome = onboardOutcome(
      200,
      listed({
        rejected: [
          { line: 4, reason: 'price must be a positive amount' },
          { line: 9, reason: 'duplicate SKU TUR-100' },
        ],
      }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      rejected: ['Line 4: price must be a positive amount.', 'Line 9: duplicate SKU TUR-100.'],
    });
  });

  it('takes any 2xx status as success, as the route answers 201', () => {
    expect(onboardOutcome(200, listed())).toEqual(onboardOutcome(201, listed()));
    expect(onboardOutcome(299, listed())).toMatchObject({ ok: true });
  });

  it('asks for a reload when the answer cannot be read, since the shop may well exist', () => {
    const message = 'Behest sent an answer this page could not read. Reload the page to see whether your shop was onboarded.';
    for (const body of [
      null,
      'ok',
      listed({ created: '6' }),
      listed({ flagged: -1 }),
      listed({ created: 1.5 }),
      listed({ rejected: null }),
      listed({ rejected: [{ line: '4', reason: 'x' }] }),
      listed({ rejected: [{ line: 4 }] }),
    ]) {
      expect(onboardOutcome(201, body), JSON.stringify(body)).toEqual({ ok: false, message, refresh: true });
    }
    expect(onboardOutcome(204, null)).toEqual({ ok: false, message, refresh: true });
  });
});

describe('a shop that was not onboarded', () => {
  it('shows the server message for a bad request as a sentence', () => {
    const body = { error: { message: 'the slug must be lower-case letters, digits and hyphens' } };
    expect(onboardOutcome(400, body)).toEqual({
      ok: false,
      message: 'The slug must be lower-case letters, digits and hyphens.',
      refresh: false,
    });
    expect(onboardOutcome(400, { error: { message: 'Photo 1 is not a JPEG image.' } })).toMatchObject({
      message: 'Photo 1 is not a JPEG image.',
    });
  });

  it('falls back to a general message for a bad request without one', () => {
    for (const body of [null, {}, { error: 'nope' }, { error: { message: '  ' } }, { error: { message: 7 } }]) {
      expect(onboardOutcome(400, body)).toEqual({
        ok: false,
        message: 'Behest could not accept that upload. Check your details and files, then try again.',
        refresh: false,
      });
    }
  });

  it('shows the existing shop when the slug is taken', () => {
    expect(onboardOutcome(409, { error: { message: 'another seller already has this slug' } })).toEqual({
      ok: false,
      message: 'A shop with this slug is already onboarded, so nothing new was saved.',
      refresh: true,
    });
  });

  it('words every other answer in plain terms', () => {
    const cases: [number | null, string][] = [
      [null, 'Could not reach Behest. Check your connection and try again.'],
      [401, 'Your session has ended. Pick the seller persona on the home page, then try again.'],
      [403, 'Only the seller persona can onboard a shop. Pick it on the home page.'],
      [
        413,
        'That upload is too large. Photos can be about 3.75 MB each and 15 MB together, so use fewer photos or a smaller CSV file.',
      ],
      [429, 'Too many uploads in a short time. Wait a minute, then try again.'],
      [502, 'Behest could not build your catalog just now, so nothing was saved. Try again in a minute.'],
      [500, "Something went wrong on Behest's side. Reload the page to see whether your shop was onboarded before you try again."],
      [503, "Something went wrong on Behest's side. Reload the page to see whether your shop was onboarded before you try again."],
    ];
    for (const [status, message] of cases) {
      expect(onboardOutcome(status, { error: { message: 'raw server text' } }), String(status)).toEqual({
        ok: false,
        message,
        refresh: false,
      });
    }
  });
});
