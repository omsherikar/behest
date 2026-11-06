import { describe, expect, it } from 'vitest';
import { decisionOutcomes } from '@/lib/dashboard/reasons';
import type { StoredRuleOutcome } from '@/lib/db/schema';

const gate: StoredRuleOutcome[] = [
  { rule: 'mandate_active', result: 'pass', detail: 'The mandate is active.' },
  { rule: 'ask_threshold', result: 'ask', detail: 'The total of $40.00 is above your $25.00 approval threshold.' },
];

describe('decisionOutcomes', () => {
  it('is just the gate outcomes when the intent check agreed, could not run or did not run', () => {
    expect(decisionOutcomes({ gateOutcomes: gate, intent: { verdict: 'consistent', reasons: [] } })).toEqual(gate);
    expect(decisionOutcomes({ gateOutcomes: gate, intent: { verdict: 'unavailable', reasons: ['timeout'] } })).toEqual(gate);
    expect(decisionOutcomes({ gateOutcomes: gate, intent: null })).toEqual(gate);
  });

  it('adds each reason of an intent check that wanted the buyer to look as an ask, after the gate rules', () => {
    const outcomes = decisionOutcomes({
      gateOutcomes: gate,
      intent: { verdict: 'needs_human', reasons: ['The request named one jar; the cart has three.', 'The brand differs.'] },
    });
    expect(outcomes).toEqual([
      ...gate,
      { rule: 'intent_check', result: 'ask', detail: 'The request named one jar; the cart has three.' },
      { rule: 'intent_check', result: 'ask', detail: 'The brand differs.' },
    ]);
  });

  it('adds the reasons of an intent check that found the cart inconsistent as blocks', () => {
    const outcomes = decisionOutcomes({
      gateOutcomes: gate,
      intent: { verdict: 'inconsistent', reasons: ['The buyer asked for spices; the cart holds earbuds.'] },
    });
    expect(outcomes.at(-1)).toEqual({
      rule: 'intent_check',
      result: 'block',
      detail: 'The buyer asked for spices; the cart holds earbuds.',
    });
  });

  it('still says why when the intent check gave no reasons', () => {
    expect(decisionOutcomes({ gateOutcomes: [], intent: { verdict: 'needs_human', reasons: [] } })).toEqual([
      { rule: 'intent_check', result: 'ask', detail: 'The intent check could not confirm that the cart matches the request.' },
    ]);
    expect(decisionOutcomes({ gateOutcomes: [], intent: { verdict: 'inconsistent', reasons: [] } })).toEqual([
      { rule: 'intent_check', result: 'block', detail: 'The intent check found that the cart does not match the request.' },
    ]);
  });
});
