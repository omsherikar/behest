import { StateGlyph, type GlyphShape } from './state-glyph';

// The gate's rule results for one purchase, in the gate's order: each rule's id in mono, its result
// as a word, a shape and a colour, and the sentence the gate wrote about it. The sentence moves
// beside the rule id when the list itself is at least 32rem wide, whatever the window.

export type RuleResult = { rule: string; result: 'pass' | 'ask' | 'block' | 'skip'; detail?: string };

const RESULT: Record<RuleResult['result'], { word: string; shape: GlyphShape; text: string }> = {
  pass: { word: 'Pass', shape: 'filled', text: 'text-seal' },
  ask: { word: 'Ask', shape: 'half', text: 'text-hold' },
  block: { word: 'Block', shape: 'crossed', text: 'text-stop' },
  skip: { word: 'Skip', shape: 'outlined', text: 'text-muted' },
};

export function RuleResults({ results, label = 'Gate rule results' }: { results: readonly RuleResult[]; label?: string }) {
  return (
    <ol aria-label={label} className="@container grid gap-1.5">
      {results.map(({ rule, result, detail }) => {
        const style = RESULT[result];
        return (
          <li key={rule} className="grid grid-cols-[4.25rem_minmax(0,1fr)] items-baseline gap-x-3 @lg:grid-cols-[4.25rem_12rem_minmax(0,1fr)]">
            <span className={`inline-flex items-center gap-1.5 text-meta font-medium ${style.text}`}>
              <StateGlyph shape={style.shape} className="size-3 self-center" />
              {style.word}
            </span>
            <span className="min-w-0 font-mono text-meta break-words text-text">{rule}</span>
            {/* Some gate sentences start with a category name in lower case; the first letter is shown capitalised. */}
            {detail && <span className="col-start-2 min-w-0 text-meta text-muted first-letter:uppercase @lg:col-start-3">{detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}
