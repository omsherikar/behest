import type { PurchaseStatus } from '@/lib/db/schema';
import type { Verdict } from '@/lib/domain/verdict';

// The authority trace of a purchase: the five steps that authorized it, in order, and how far it
// got. A step is done when it passed, current while Behest is working on it, held when it is the
// reason the purchase waited for the buyer (or where it waits now), stopped when the purchase
// ended there, and not reached after that. Pure, so the browser can draw a trace from a purchase
// row and the tests can walk every status.

export const TRACE_STEPS = ['mandate', 'gate', 'intent', 'paypal', 'receipt'] as const;
export type TraceStep = (typeof TRACE_STEPS)[number];

export const STEP_STATES = ['done', 'current', 'held', 'stopped', 'not_reached'] as const;
export type StepState = (typeof STEP_STATES)[number];

export type TraceStates = Record<TraceStep, StepState>;

/** Each step's name in the interface. */
export const STEP_NAMES: Record<TraceStep, string> = {
  mandate: 'Mandate',
  gate: 'Gate',
  intent: 'Intent check',
  paypal: 'PayPal',
  receipt: 'Receipt',
};

/** Each state as a word, so a state never rests on its colour alone. */
export const STATE_WORDS: Record<StepState, string> = {
  done: 'Done',
  current: 'In progress',
  held: 'Held',
  stopped: 'Stopped',
  not_reached: 'Not reached',
};

/** Statuses in which PayPal took the buyer's money, whatever happened to it after. */
const CHARGED: ReadonlySet<PurchaseStatus> = new Set(['captured', 'accepted', 'settled', 'disputed', 'resolved', 'refunded']);
/** Statuses that ended a purchase without a charge. */
const ENDED_UNPAID: ReadonlySet<PurchaseStatus> = new Set(['blocked', 'failed', 'cancelled']);

/**
 * The trace of a purchase from what the purchases table stores: its status, the gate's verdict,
 * the final verdict after the intent check (null until the check has run) and whether a receipt
 * was signed.
 *
 * - Mandate: always done. A purchase is only ever checked against the buyer's mandate.
 * - Gate: done on ALLOW, held on ASK (it asked the buyer), stopped on BLOCK.
 * - Intent check: not reached after the gate blocked; in progress while the purchase is proposed
 *   and has no final verdict; stopped when it tightened the verdict to BLOCK, or when the purchase
 *   ended before a verdict was recorded; held when it tightened ALLOW to ASK; done otherwise.
 * - PayPal: held while the buyer has not yet approved at PayPal; in progress while the purchase is
 *   routed or charged; done once charged; stopped when the buyer cancelled or the charge failed.
 * - Receipt: done once signed; in progress for a charged purchase still waiting for its receipt,
 *   unless the money was refunded first.
 */
export function trailFromPurchase(
  status: PurchaseStatus,
  gateVerdict: Verdict,
  finalVerdict: Verdict | null,
  hasReceipt: boolean,
): TraceStates {
  const trace: TraceStates = {
    mandate: 'done',
    gate: gateVerdict === 'ALLOW' ? 'done' : gateVerdict === 'ASK' ? 'held' : 'stopped',
    intent: 'not_reached',
    paypal: 'not_reached',
    receipt: 'not_reached',
  };
  if (trace.gate === 'stopped') return trace;

  trace.intent = intentState(status, gateVerdict, finalVerdict);
  if (trace.intent !== 'done' && trace.intent !== 'held') return trace;

  trace.paypal = paypalState(status);
  if (trace.paypal !== 'done') return trace;

  trace.receipt = hasReceipt ? 'done' : status === 'refunded' ? 'not_reached' : 'current';
  return trace;
}

function intentState(status: PurchaseStatus, gateVerdict: Verdict, finalVerdict: Verdict | null): StepState {
  if (finalVerdict === null) {
    if (status === 'proposed') return 'current';
    // Ended before the check recorded a verdict, such as a proposal abandoned during the check.
    return ENDED_UNPAID.has(status) ? 'stopped' : 'done';
  }
  if (finalVerdict === 'BLOCK') return 'stopped';
  if (finalVerdict === 'ASK' && gateVerdict === 'ALLOW') return 'held';
  return 'done';
}

function paypalState(status: PurchaseStatus): StepState {
  if (CHARGED.has(status)) return 'done';
  switch (status) {
    case 'awaiting_approval':
      return 'held';
    case 'proposed':
    case 'charging':
      return 'current';
    case 'cancelled':
    case 'failed':
      return 'stopped';
    // A purchase blocked after a verdict that let it go on never reached PayPal.
    default:
      return 'not_reached';
  }
}
