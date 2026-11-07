import { STATE_WORDS, STEP_NAMES, type TraceStates, TRACE_STEPS } from '@/lib/ui/trail';
import { STATE_SHAPES, STATE_TEXT, StateGlyph } from './state-glyph';

// A purchase's authority trace in one line of small glyphs, for a table row: the same shapes and
// colours as the full trace, read out as words by a screen reader.

export function MiniTrace({ states }: { states: TraceStates }) {
  const label = TRACE_STEPS.map((step) => `${STEP_NAMES[step]} ${STATE_WORDS[states[step]].toLowerCase()}`).join(', ');
  return (
    <span role="img" aria-label={`Authority trace: ${label}`} className="inline-flex items-center gap-1">
      {TRACE_STEPS.map((step, index) => (
        <span key={step} className="inline-flex items-center gap-1">
          {index > 0 && <span aria-hidden className={`h-px w-2 ${states[step] === 'not_reached' ? 'bg-line-strong/50' : 'bg-current'} ${STATE_TEXT[states[step]]}`} />}
          <span className={STATE_TEXT[states[step]]}>
            <StateGlyph shape={STATE_SHAPES[states[step]]} className="size-3" />
          </span>
        </span>
      ))}
    </span>
  );
}
