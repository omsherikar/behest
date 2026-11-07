'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { Persona } from '@/lib/session';
import { PERSONA_INFO, personaInfo } from '@/lib/ui/personas';
import { useSwitchPersona } from './use-switch-persona';

// "Viewing as Buyer" in the top bar. It opens a short list of the three personas, each with what a
// visitor can do as it; choosing another starts that persona's session and opens its home page.
// A disclosure, not a menu: the list holds ordinary buttons, reached with Tab. Escape, a click
// outside or tabbing away closes it.

export function PersonaSwitcher({ current }: { current: Persona }) {
  const [open, setOpen] = useState(false);
  const { switchTo, pending, failed } = useSwitchPersona();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((shown) => !shown)}
        className="flex h-8 items-center gap-2 rounded-control border border-line px-2.5 text-body transition-colors hover:border-line-strong hover:bg-raised"
      >
        <span className="text-muted">Viewing as</span>
        <span className="font-medium text-text">{personaInfo(current).name}</span>
        <svg viewBox="0 0 16 16" aria-hidden className={`size-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div
        id={listId}
        hidden={!open}
        className="absolute top-full right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-panel border border-line bg-panel p-1 shadow-2xl shadow-black/40"
      >
        <p className="px-3 pt-2 pb-1 text-meta text-muted">Switch persona</p>
        <ul>
          {PERSONA_INFO.map((info) => {
            const here = info.persona === current;
            return (
              <li key={info.persona}>
                <button
                  type="button"
                  aria-current={here ? 'true' : undefined}
                  disabled={pending !== null}
                  onClick={() => (here ? setOpen(false) : switchTo(info.persona, info.home))}
                  className="flex w-full flex-col items-start gap-0.5 rounded-control px-3 py-2 text-left transition-colors hover:bg-raised focus-visible:outline-offset-[-2px] disabled:cursor-wait"
                >
                  <span className="flex items-center gap-2 font-medium text-text">
                    {info.name}
                    {here && <span className="text-meta font-normal text-muted">Current</span>}
                    {pending === info.persona && <span className="text-meta font-normal text-muted">Opening...</span>}
                  </span>
                  <span className="text-meta text-muted">{info.does}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {failed && (
          <p role="alert" className="px-3 py-2 text-meta text-stop">
            Could not switch persona. Try again.
          </p>
        )}
      </div>
    </div>
  );
}
