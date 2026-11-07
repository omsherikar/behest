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
  'dont set up this mandate.',
])('reads %j as declining', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(true);
});

it.each(['Buy on any day', 'Set up this mandate', "Don't set up this mandate yet", ''])('reads %j as an answer', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(false);
});

describe('withDeclineOption', () => {
  it.each([
    "Don't set up this mandate",
    'Don\u2019t set up this mandate.',
    'dont set up this mandate.',
    "DON'T SET UP THIS MANDATE",
  ])('replaces the decline written as %j with the one decline option, last', (decline) => {
    expect(withDeclineOption(['Buy on any day', decline, 'Only on Saturdays'])).toEqual([
      'Buy on any day',
      'Only on Saturdays',
      DECLINE_ANSWER,
    ]);
  });

  it('keeps every other option as the model wrote it, even one that reads like a decline', () => {
    const options = ["Don't include beverages in this mandate", "Don't create this mandate", 'Set up the mandate anyway'];
    expect(withDeclineOption(options)).toEqual([...options, DECLINE_ANSWER]);
  });

  it('adds the decline option to a question that offers none, and to one with no options at all', () => {
    expect(withDeclineOption(['Allow all beverages', 'Leave beverages out'])).toEqual([
      'Allow all beverages',
      'Leave beverages out',
      DECLINE_ANSWER,
    ]);
    expect(withDeclineOption([])).toEqual([DECLINE_ANSWER]);
  });
});
