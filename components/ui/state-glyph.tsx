import type { StepState } from '@/lib/ui/trail';

// The shape of a state, so that no state rests on colour alone: filled for done, a ring with a dot
// for in progress, half filled for held, crossed for stopped and a dashed outline for not reached.
// Notices add an "i" in a ring for information, and `open`, a plain circle, marks something that
// went through unchanged, as on the security page. It draws in the current text colour; the caller
// sets the state colour and the size.

export type GlyphShape = 'filled' | 'ring' | 'half' | 'crossed' | 'outlined' | 'open' | 'info';

export const STATE_SHAPES: Record<StepState, GlyphShape> = {
  done: 'filled',
  current: 'ring',
  held: 'half',
  stopped: 'crossed',
  not_reached: 'outlined',
};

/** Each state's text colour. Every one keeps 4.5:1 on the page, the panels and the tints. */
export const STATE_TEXT: Record<StepState, string> = {
  done: 'text-seal',
  current: 'text-text',
  held: 'text-hold',
  stopped: 'text-stop',
  not_reached: 'text-muted',
};

export function StateGlyph({ shape, pulse = false, className = 'size-4' }: { shape: GlyphShape; pulse?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden focusable="false" className={`shrink-0 ${className}`}>
      {shape === 'filled' ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="m5 8.2 2 2 4-4.4" fill="none" className="stroke-bg" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle
          cx="8"
          cy="8"
          r="6.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={shape === 'outlined' ? '2.6 2.3' : undefined}
        />
      )}
      {shape === 'ring' && <circle cx="8" cy="8" r="2.6" fill="currentColor" className={pulse ? 'motion-safe:animate-trace-pulse' : undefined} />}
      {shape === 'half' && <path d="M8 1.75a6.25 6.25 0 0 0 0 12.5Z" fill="currentColor" />}
      {shape === 'info' && <path d="M8 7.2v4M8 4.9v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {shape === 'crossed' && <path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
    </svg>
  );
}
