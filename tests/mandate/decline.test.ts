import { describe, expect, it } from 'vitest';
import { DECLINE_ANSWER, isDeclineAnswer, withDeclineOption } from '@/lib/mandate/decline';

it('is the option the compiler offers for a limit Behest cannot enforce', () => {
  expect(DECLINE_ANSWER).toBe("Don't set up this mandate");
});

it.each([
  "Don't set up this mandate",
  'Don\u2019t set up this mandate',
  "don't SET UP this mandate",
  "  Don't  set up\tthis mandate. ",
])('reads %j as declining', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(true);
});

it.each(['Buy on any day', 'Set up this mandate', "Don't set up this mandate yet", ''])('reads %j as an answer', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(false);
});

describe('withDeclineOption', () => {
  it.each([
    "Don't create this mandate",
    "Don't set up this mandate",
    'Don\u2019t set up this mandate.',
    'Dont make the mandate',
    'Do not set up this mandate',
    "don't go ahead with this mandate",
  ])('replaces the model wording %j with the one decline option, last', (decline) => {
    expect(withDeclineOption(['Buy on any day', decline, 'Only on Saturdays'])).toEqual([
      'Buy on any day',
      'Only on Saturdays',
      DECLINE_ANSWER,
    ]);
  });

  it('adds the decline option to a question that offers none, and to one with no options at all', () => {
    expect(withDeclineOption(['Allow all beverages', 'Leave beverages out'])).toEqual([
      'Allow all beverages',
      'Leave beverages out',
      DECLINE_ANSWER,
    ]);
    expect(withDeclineOption([])).toEqual([DECLINE_ANSWER]);
  });

  it("keeps options that mention the mandate or say don't without declining it", () => {
    expect(withDeclineOption(['Set up the mandate anyway', "Don't limit the day"])).toEqual([
      'Set up the mandate anyway',
      "Don't limit the day",
      DECLINE_ANSWER,
    ]);
  });
});
