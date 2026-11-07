import type { Verdict } from '@/lib/domain/verdict';
import type { StepState } from './trail';

// Behest's verdict on a purchase in words, never as a bare code. "Your" when the buyer reads it;
// pages others read too, such as the dashboard, say it without the person.

const PERSONAL: Record<Verdict, string> = { ALLOW: 'Allowed', ASK: 'Needs your approval', BLOCK: 'Blocked' };
const IMPERSONAL: Record<Verdict, string> = { ALLOW: 'Allowed', ASK: 'Needs approval', BLOCK: 'Blocked' };

/** The verdict in words, addressed to the buyer unless `personal` is false. */
export function verdictWords(verdict: Verdict, personal = true): string {
  return (personal ? PERSONAL : IMPERSONAL)[verdict];
}

/** The trace state a verdict looks like, so a verdict and a trace step share a shape and a colour. */
export const VERDICT_STATE: Record<Verdict, StepState> = { ALLOW: 'done', ASK: 'held', BLOCK: 'stopped' };
