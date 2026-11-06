import { z } from 'zod';

// The outcome of a purchase decision. ALLOW pays now, ASK waits for the buyer, BLOCK pays nothing.

export const Verdict = z.enum(['ALLOW', 'ASK', 'BLOCK']);
export type Verdict = z.infer<typeof Verdict>;

const SEVERITY: Record<Verdict, number> = { ALLOW: 0, ASK: 1, BLOCK: 2 };

/**
 * The most severe of the given verdicts. An empty list throws instead of returning ALLOW,
 * so a decision with no recorded reasons can never authorize a payment.
 */
export function maxVerdict(...verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) throw new Error('maxVerdict needs at least one verdict');
  return verdicts.reduce((worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst));
}
