import { describe, expect, it } from 'vitest';
import { type PurchaseStatus, purchaseStatus } from '@/lib/db/schema';
import type { Verdict } from '@/lib/domain/verdict';
import { STEP_STATES, type TraceStates, TRACE_STEPS, trailFromPurchase } from '@/lib/ui/trail';

const STATUSES = purchaseStatus.enumValues;
const VERDICTS: Verdict[] = ['ALLOW', 'ASK', 'BLOCK'];
const FINAL_VERDICTS: (Verdict | null)[] = [null, ...VERDICTS];

/** The five states in step order, for compact expectations. */
const row = (trace: TraceStates) => TRACE_STEPS.map((step) => trace[step]);

const every = STATUSES.flatMap((status) =>
  VERDICTS.flatMap((gate) =>
    FINAL_VERDICTS.flatMap((final) => [true, false].map((receipt) => [status, gate, final, receipt] as const)),
  ),
);

describe('trailFromPurchase', () => {
  it('walks all 12 purchase statuses', () => {
    expect(STATUSES).toHaveLength(12);
  });

  describe.each(every)('for %s, gate %s, final %s, receipt %s', (status, gate, final, receipt) => {
    const trace = trailFromPurchase(status, gate, final, receipt);
    const states = row(trace);

    it('gives every step one known state', () => {
      expect(Object.keys(trace)).toEqual([...TRACE_STEPS]);
      for (const state of states) expect(STEP_STATES).toContain(state);
    });

    it('starts from the mandate and shows the gate verdict', () => {
      expect(trace.mandate).toBe('done');
      expect(trace.gate).toBe({ ALLOW: 'done', ASK: 'held', BLOCK: 'stopped' }[gate]);
    });

    it('reaches nothing after a step that stopped, is in progress or was not reached', () => {
      const end = states.findIndex((state) => state === 'stopped' || state === 'current' || state === 'not_reached');
      if (end === -1) return;
      expect(states.slice(end + 1).every((state) => state === 'not_reached')).toBe(true);
    });

    it('reaches the receipt only after PayPal charged', () => {
      if (trace.receipt !== 'not_reached') expect(trace.paypal).toBe('done');
      if (trace.receipt === 'done') expect(receipt).toBe(true);
    });

    it('never takes a stored BLOCK past the step that blocked', () => {
      if (gate === 'BLOCK' || final === 'BLOCK') expect(trace.paypal).toBe('not_reached');
    });
  });

  it.each<[string, PurchaseStatus, Verdict, Verdict | null, boolean, string[]]>([
    ['the gate blocked it', 'blocked', 'BLOCK', 'BLOCK', false, ['done', 'stopped', 'not_reached', 'not_reached', 'not_reached']],
    ['the intent check is running', 'proposed', 'ALLOW', null, false, ['done', 'done', 'current', 'not_reached', 'not_reached']],
    ['the intent check blocked it', 'blocked', 'ALLOW', 'BLOCK', false, ['done', 'done', 'stopped', 'not_reached', 'not_reached']],
    ['it is on its way to PayPal', 'proposed', 'ALLOW', 'ALLOW', false, ['done', 'done', 'done', 'current', 'not_reached']],
    ['it is being charged', 'charging', 'ALLOW', 'ALLOW', false, ['done', 'done', 'done', 'current', 'not_reached']],
    ['it was paid and the receipt is being signed', 'captured', 'ALLOW', 'ALLOW', false, ['done', 'done', 'done', 'done', 'current']],
    ['it was paid with a receipt', 'captured', 'ALLOW', 'ALLOW', true, ['done', 'done', 'done', 'done', 'done']],
    ['the seller accepted it', 'accepted', 'ALLOW', 'ALLOW', true, ['done', 'done', 'done', 'done', 'done']],
    ['the gate asked the buyer', 'awaiting_approval', 'ASK', 'ASK', false, ['done', 'held', 'done', 'held', 'not_reached']],
    ['the intent check asked the buyer', 'awaiting_approval', 'ALLOW', 'ASK', false, ['done', 'done', 'held', 'held', 'not_reached']],
    ['the buyer approved and it is being charged', 'charging', 'ASK', 'ASK', false, ['done', 'held', 'done', 'current', 'not_reached']],
    ['the buyer approved and it was paid', 'settled', 'ASK', 'ASK', true, ['done', 'held', 'done', 'done', 'done']],
    ['the buyer cancelled at PayPal', 'cancelled', 'ASK', 'ASK', false, ['done', 'held', 'done', 'stopped', 'not_reached']],
    ['the charge failed', 'failed', 'ALLOW', 'ALLOW', false, ['done', 'done', 'done', 'stopped', 'not_reached']],
    ['it was abandoned during the check', 'failed', 'ALLOW', null, false, ['done', 'done', 'stopped', 'not_reached', 'not_reached']],
    ['it was disputed', 'disputed', 'ALLOW', 'ALLOW', true, ['done', 'done', 'done', 'done', 'done']],
    ['the dispute closed', 'resolved', 'ASK', 'ASK', true, ['done', 'held', 'done', 'done', 'done']],
    ['it was refunded after its receipt', 'refunded', 'ALLOW', 'ALLOW', true, ['done', 'done', 'done', 'done', 'done']],
    ['it was refunded before a receipt', 'refunded', 'ALLOW', 'ALLOW', false, ['done', 'done', 'done', 'done', 'not_reached']],
  ])('traces a purchase where %s', (_, status, gate, final, receipt, expected) => {
    expect(row(trailFromPurchase(status, gate, final, receipt))).toEqual(expected);
  });
});
