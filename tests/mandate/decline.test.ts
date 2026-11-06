import { expect, it } from 'vitest';
import { DECLINE_ANSWER, isDeclineAnswer } from '@/lib/mandate/decline';

it('is the option the compiler offers for a limit Behest cannot enforce', () => {
  expect(DECLINE_ANSWER).toBe("Don't set up this mandate");
});

it.each([
  "Don't set up this mandate",
  'Don’t set up this mandate',
  "don't SET UP this mandate",
  "  Don't  set up\tthis mandate. ",
])('reads %j as declining', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(true);
});

it.each(['Buy on any day', 'Set up this mandate', "Don't set up this mandate yet", ''])('reads %j as an answer', (answer) => {
  expect(isDeclineAnswer(answer)).toBe(false);
});
