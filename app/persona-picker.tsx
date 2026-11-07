'use client';

import { useSwitchPersona } from '@/components/shell/use-switch-persona';
import { Notice } from '@/components/ui/notice';
import { PERSONA_INFO } from '@/lib/ui/personas';

// The three personas of the demo, as three cards: what a visitor can do as each and the pages it
// opens. Choosing one starts its session and opens its home page.

export function PersonaPicker() {
  const { switchTo, pending, failed } = useSwitchPersona();

  return (
    <div>
      <ul aria-label="Personas" className="grid gap-4 md:grid-cols-3">
        {PERSONA_INFO.map(({ persona, name, does, home, nav }) => (
          <li key={persona} className="min-w-0">
            <button
              type="button"
              onClick={() => switchTo(persona, home)}
              disabled={pending !== null}
              className="group flex h-full w-full flex-col items-start rounded-frame border border-line bg-surface p-6 text-left shadow-[var(--highlight)] transition-colors hover:border-line-strong hover:bg-raised disabled:cursor-wait"
            >
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="text-heading font-medium text-text">{name}</span>
                {pending === persona && <span className="text-meta text-muted">Opening...</span>}
              </span>
              <span className="mt-2 text-body text-muted">{does}</span>
              <span className="mt-6 mb-6 flex flex-wrap gap-1.5">
                {nav.map((item) => (
                  <span key={item.href} className="rounded-full border border-line px-2.5 py-0.5 text-meta text-muted">
                    {item.label}
                  </span>
                ))}
              </span>
              {/* The card is the button; this pill only shows it. */}
              <span aria-hidden className="mt-auto inline-flex h-9 items-center rounded-full border border-line-strong px-4 text-meta font-medium text-text transition-colors group-hover:border-transparent group-hover:bg-text group-hover:text-on-fill">
                Open as {name.toLowerCase()}
              </span>
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
