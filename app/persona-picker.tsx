'use client';

import { useSwitchPersona } from '@/components/shell/use-switch-persona';
import { Notice } from '@/components/ui/notice';
import { PERSONA_INFO } from '@/lib/ui/personas';

// The three personas of the demo, each with what a visitor can do as it and the pages it opens.
// Choosing one starts its session and opens its home page.

export function PersonaPicker() {
  const { switchTo, pending, failed } = useSwitchPersona();

  return (
    <div>
      <ul aria-label="Personas" className="divide-y divide-line overflow-hidden rounded-panel border border-line bg-panel">
        {PERSONA_INFO.map(({ persona, name, does, home, nav }) => (
          <li key={persona}>
            <button
              type="button"
              onClick={() => switchTo(persona, home)}
              disabled={pending !== null}
              className="flex w-full flex-col gap-1 px-4 py-4 text-left transition-colors hover:bg-raised focus-visible:outline-offset-[-2px] disabled:cursor-wait sm:px-5"
            >
              <span className="flex items-baseline gap-2">
                <span className="text-lead font-medium text-text">{name}</span>
                {pending === persona && <span className="text-meta text-muted">Opening...</span>}
              </span>
              <span className="text-body text-muted">{does}</span>
              <span className="mt-1 text-meta text-muted">{nav.map((item) => item.label).join(', ')}</span>
            </button>
          </li>
        ))}
      </ul>
      {failed && (
        <Notice kind="stop" className="mt-4">
          Could not start that session. Try again.
        </Notice>
      )}
    </div>
  );
}
