import type { Verdict } from '@/lib/domain/verdict';
import { verdictWords } from '@/lib/ui/verdict';
import { StatusBadge, type BadgeTone } from './status-badge';

// Behest's verdict on a purchase: a word, a shape and the state colour, the same shape and colour
// its trace step takes. Renders the same on the server and in the browser, so the shop timeline,
// the ledger grid and the dashboard share it.

const TONE: Record<Verdict, BadgeTone> = { ALLOW: 'seal', ASK: 'hold', BLOCK: 'stop' };

export function VerdictBadge({
  verdict,
  count,
  personal = true,
}: {
  verdict: Verdict;
  /** How many purchases had this verdict, for a summary of several. */
  count?: number;
  /** False where people other than the buyer read it: "Needs approval" instead of "Needs your approval". */
  personal?: boolean;
}) {
  return (
    <StatusBadge tone={TONE[verdict]} label="Verdict">
      {verdictWords(verdict, personal)}
      {count !== undefined && <span className="font-mono text-text tabular-nums">{count}</span>}
    </StatusBadge>
  );
}
