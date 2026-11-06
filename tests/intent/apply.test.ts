import { expect, it } from 'vitest';
import { maxVerdict, Verdict } from '@/lib/domain/verdict';
import { applyIntent } from '@/lib/intent/apply';
import type { IntentResult } from '@/lib/intent/types';

const INTENT_VERDICTS: IntentResult['verdict'][] = ['consistent', 'needs_human', 'inconsistent', 'unavailable'];

const intent = (verdict: IntentResult['verdict']): IntentResult => ({ verdict, reasons: [] });

it.each<[Verdict, IntentResult['verdict'], Verdict]>([
  ['ALLOW', 'consistent', 'ALLOW'],
  ['ALLOW', 'needs_human', 'ASK'],
  ['ALLOW', 'inconsistent', 'BLOCK'],
  ['ALLOW', 'unavailable', 'ASK'],
  ['ASK', 'consistent', 'ASK'],
  ['ASK', 'needs_human', 'ASK'],
  ['ASK', 'inconsistent', 'BLOCK'],
  ['ASK', 'unavailable', 'ASK'],
  ['BLOCK', 'consistent', 'BLOCK'],
  ['BLOCK', 'needs_human', 'BLOCK'],
  ['BLOCK', 'inconsistent', 'BLOCK'],
  ['BLOCK', 'unavailable', 'BLOCK'],
])('turns %s with a %s check into %s', (gate, verdict, expected) => {
  expect(applyIntent(gate, intent(verdict))).toBe(expected);
});

it('never returns a verdict less severe than the gate', () => {
  for (const gate of Verdict.options) {
    for (const verdict of INTENT_VERDICTS) {
      const result = applyIntent(gate, intent(verdict));
      expect(maxVerdict(gate, result), `${gate} with ${verdict}`).toBe(result);
    }
  }
});

it('allows only what the gate allowed and the check found consistent', () => {
  for (const gate of Verdict.options) {
    for (const verdict of INTENT_VERDICTS) {
      const allowed = applyIntent(gate, intent(verdict)) === 'ALLOW';
      expect(allowed, `${gate} with ${verdict}`).toBe(gate === 'ALLOW' && verdict === 'consistent');
    }
  }
});

it.each(['approved', 'toString', ''])('sends an allowed cart to the buyer when the check result is %j', (verdict) => {
  const unknown = { verdict, reasons: [] } as unknown as IntentResult;

  expect(applyIntent('ALLOW', unknown)).toBe('ASK');
});
