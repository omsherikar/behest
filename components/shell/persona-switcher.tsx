'use client';

import { useId } from 'react';
import type { Persona } from '@/lib/session';
import { PERSONA_INFO } from '@/lib/ui/personas';
import { cn } from '@/lib/utils';
import { useSwitchPersona } from './use-switch-persona';

// The persona switcher in the top bar: a segmented pill of the three personas, the current one lit.
// Choosing another starts that persona's session and opens its home page; each segment's tooltip
// says what a visitor can do as that persona. If the session cannot be started, it says so under
// the pill.

export function PersonaSwitcher({ current }: { current: Persona }) {
  const { switchTo, pending, failed } = useSwitchPersona();
  // Names the group even where the words are hidden: aria-labelledby reads hidden text too.
  const labelId = useId();

  return (
    <div className="relative flex items-center gap-3">
      <span id={labelId} className="hidden text-meta text-muted xl:inline">
        Viewing as
      </span>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-busy={pending !== null}
        className="flex h-10 items-center rounded-full border border-line bg-black/35 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
      >
        {PERSONA_INFO.map((info) => {
          const here = info.persona === current;
          const opening = pending === info.persona;
          return (
            <button
              key={info.persona}
              type="button"
              aria-current={here ? 'true' : undefined}
              title={info.does}
              disabled={pending !== null}
              onClick={() => (here ? undefined : switchTo(info.persona, info.home))}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-0 disabled:cursor-wait sm:px-3.5',
                here ? 'bg-white/[0.1] text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]' : 'text-muted hover:text-text',
              )}
            >
              {opening && <span aria-hidden className="size-1.5 rounded-full bg-text motion-safe:animate-trace-pulse" />}
              {info.name}
              {opening && <span className="sr-only">, opening</span>}
            </button>
          );
        })}
      </div>
      {failed && (
        <p role="alert" className="glass absolute top-full right-0 mt-3 w-max max-w-[calc(100vw-2rem)] rounded-xl px-3 py-2 text-meta text-stop">
          Could not switch persona. Try again.
        </p>
      )}
    </div>
  );
}
