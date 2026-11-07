import type { Verdict } from '@/lib/domain/verdict';
import { VERDICT_STATE, verdictWords } from '@/lib/ui/verdict';
import { STATE_SHAPES, STATE_TEXT, StateGlyph } from './state-glyph';

// Behest's verdict on a purchase: a word, a shape and the state colour, the same shape and colour
// its trace step takes. Renders the same on the server and in the browser, so the shop timeline,
// the ledger grid and the dashboard share it.

const TINT: Record<Verdict, string> = {
  ALLOW: 'border-seal/35 bg-seal/12',
  ASK: 'border-hold/35 bg-hold/12',
  BLOCK: 'border-stop/35 bg-stop/12',
};

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
  const state = VERDICT_STATE[verdict];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-control border px-2 text-meta font-medium whitespace-nowrap ${TINT[verdict]} ${STATE_TEXT[state]}`}
    >
      <StateGlyph shape={STATE_SHAPES[state]} className="size-3" />
      <span className="sr-only">Verdict: </span>
      {verdictWords(verdict, personal)}
      {count !== undefined && <span className="font-mono text-text tabular-nums">{count}</span>}
    </span>
  );
}
