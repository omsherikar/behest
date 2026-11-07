'use client';

import { type ReactNode, useId, useState } from 'react';
import { cn } from '@/lib/utils';

// Questions that open one at a time to their answers. Adapted from VengeanceUI's faq-accordion
// (https://www.vengenceui.com/r/faq-accordion.json): hairline rows on black, a plus that turns into
// a minus, a bar down the left edge that lights for the open answer, and an answer that slides open.
// A closed answer is inert, so it is out of the tab order and hidden from screen readers.

export type FaqItem = { question: string; answer: ReactNode };

export function FaqAccordion({ items, className }: { items: readonly FaqItem[]; className?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const id = useId();

  return (
    <ul className={cn('border-l-2 border-line', className)}>
      {items.map((item, index) => {
        const isOpen = open === index;
        const buttonId = `${id}-q${index}`;
        const panelId = `${id}-a${index}`;
        return (
          <li key={item.question} className="relative border-b border-line last:border-b-0">
            <span
              aria-hidden
              className={cn('absolute top-0 bottom-0 -left-0.5 w-0.5 transition-colors duration-300', isOpen ? 'bg-text' : 'bg-transparent')}
            />
            <h3>
              <button
                id={buttonId}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : index)}
                className={cn(
                  'group flex w-full items-center gap-4 py-5 pr-2 pl-5 text-left text-lead transition-colors focus-visible:outline-offset-[-2px] sm:pl-6',
                  isOpen ? 'text-text' : 'text-text/85 hover:text-text',
                )}
              >
                <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-muted transition-colors group-hover:text-text">
                  <path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path
                    d="M8 3v10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    className={cn('origin-center transition-transform duration-300', isOpen && 'scale-y-0')}
                  />
                </svg>
                <span className="min-w-0 flex-1">{item.question}</span>
              </button>
            </h3>
            <div
              id={panelId}
              role="region"
              aria-labelledby={buttonId}
              inert={!isOpen}
              className={cn('grid transition-[grid-template-rows] duration-300 ease-out', isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}
            >
              <div className="overflow-hidden">
                <div className="max-w-[62ch] pr-2 pb-6 pl-13 text-body text-muted sm:pl-14">{item.answer}</div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
