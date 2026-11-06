import { maxVerdict, type Verdict } from '@/lib/domain/verdict';
import type { IntentResult } from './types';

// The intent check only ever raises concerns, so its result can move the gate's verdict toward the
// buyer and never away: a check that finds the cart consistent leaves the verdict as it was.

const AT_LEAST: Record<IntentResult['verdict'], Verdict> = {
  consistent: 'ALLOW',
  needs_human: 'ASK',
  inconsistent: 'BLOCK',
  // A check that could not run is a check that did not pass, so the buyer decides.
  unavailable: 'ASK',
};

/**
 * The verdict after the intent check: the gate's verdict, tightened to at least what the check
 * found. A check result this code does not know counts as unavailable.
 */
export function applyIntent(gate: Verdict, intent: IntentResult): Verdict {
  const floor = Object.hasOwn(AT_LEAST, intent.verdict) ? AT_LEAST[intent.verdict] : AT_LEAST.unavailable;
  return maxVerdict(gate, floor);
}
