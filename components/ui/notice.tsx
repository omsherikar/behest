import type { ReactNode } from 'react';
import { StateGlyph, type GlyphShape } from './state-glyph';

// A message about something that just happened, in four kinds: info, success, hold (waiting for
// the buyer) and stop (something failed or was refused). Each has a word-bearing message, a shape
// and a colour. Stop interrupts a screen reader (role="alert"); the others wait (role="status").

export type NoticeKind = 'info' | 'success' | 'hold' | 'stop';

const STYLE: Record<NoticeKind, { box: string; glyph: string; shape: GlyphShape }> = {
  info: { box: 'border-line bg-raised', glyph: 'text-muted', shape: 'info' },
  success: { box: 'border-seal/35 bg-seal/12', glyph: 'text-seal', shape: 'filled' },
  hold: { box: 'border-hold/35 bg-hold/12', glyph: 'text-hold', shape: 'half' },
  stop: { box: 'border-stop/35 bg-stop/12', glyph: 'text-stop', shape: 'crossed' },
};

export function Notice({
  kind,
  title,
  children,
  className = '',
}: {
  kind: NoticeKind;
  /** A short first line in bold, when the message needs one. */
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const style = STYLE[kind];
  return (
    <div role={kind === 'stop' ? 'alert' : 'status'} className={`flex gap-3 rounded-panel border px-4 py-3 text-body text-text ${style.box} ${className}`}>
      <span className={`mt-[3px] ${style.glyph}`}>
        <StateGlyph shape={style.shape} className="size-4" />
      </span>
      <div className="min-w-0 break-words">
        {title && <p className="font-medium">{title}</p>}
        <div className={title ? 'mt-0.5 text-muted' : undefined}>{children}</div>
      </div>
    </div>
  );
}
