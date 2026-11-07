import type { ReactNode } from 'react';
import { StateGlyph, type GlyphShape } from './state-glyph';

// A state as a small badge: a word, a shape and a tone, so it never rests on colour alone. The
// verdict badge, a receipt check, a payout and a listing's standing with agents all use it.

export type BadgeTone = 'seal' | 'hold' | 'stop' | 'muted';

const TONES: Record<BadgeTone, string> = {
  seal: 'border-seal/35 bg-seal/12 text-seal',
  hold: 'border-hold/35 bg-hold/12 text-hold',
  stop: 'border-stop/35 bg-stop/12 text-stop',
  muted: 'border-line-strong/60 bg-raised text-muted',
};

/** The shape that goes with each tone unless a badge says otherwise. */
const SHAPES: Record<BadgeTone, GlyphShape> = { seal: 'filled', hold: 'half', stop: 'crossed', muted: 'outlined' };

export function StatusBadge({
  tone,
  shape = SHAPES[tone],
  label,
  children,
}: {
  tone: BadgeTone;
  shape?: GlyphShape;
  /** Read before the words by a screen reader, such as "Verdict" or "Receipt check". */
  label?: string;
  children: ReactNode;
}) {
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-control border px-2 text-meta font-medium whitespace-nowrap ${TONES[tone]}`}>
      <StateGlyph shape={shape} className="size-3" />
      {label && <span className="sr-only">{label}: </span>}
      {children}
    </span>
  );
}
