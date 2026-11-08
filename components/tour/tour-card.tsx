'use client';

import Link from 'next/link';
import { forwardRef, useId } from 'react';
import { buttonClass } from '@/components/ui/button';
import { NOT_LOADED, ROLE_LABEL, type TourStep } from '@/lib/tour/steps';

// The guided demo's card: which role and step the judge is on, what the ringed part of the page
// shows, and the buttons to move on. It only presents; the tour controller places it and acts on
// its buttons. The last card hands over to the judge instead of counting steps.

export type TourCardProps = {
  step: TourStep;
  /** The step's index; at `total` it is the end card. */
  index: number;
  /** How many steps there are, not counting the end card. */
  total: number;
  /** Whether the record the step points at is not loaded on this site. */
  missing: boolean;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
  className?: string;
  style?: React.CSSProperties;
};

/** The ref is the primary button (Next or Finish), which takes focus on each step. */
export const TourCard = forwardRef<HTMLButtonElement, TourCardProps>(function TourCard(
  { step, index, total, missing, onBack, onNext, onClose, className = '', style },
  primary,
) {
  const titleId = useId();
  const atEnd = index >= total;
  const label = step.role === null ? 'Guided demo' : `Guided demo · ${ROLE_LABEL[step.role]}`;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      style={style}
      className={`w-[min(26rem,calc(100vw-2rem))] rounded-panel border border-line-strong bg-surface p-5 text-text shadow-2xl shadow-black/60 ${className}`}
    >
      <div className="flex items-center gap-2 text-meta text-muted">
        <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3z" fill="currentColor" />
        </svg>
        <span>{label}</span>
        {!atEnd && (
          <span className="ml-auto tabular-nums">
            Step {index + 1} of {total}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the guided demo"
          className={`${atEnd ? 'ml-auto' : 'ml-2'} -mr-1.5 inline-flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.06] hover:text-text motion-reduce:transition-none`}
        >
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
            <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <h2 id={titleId} className="mt-3 text-heading font-medium text-balance text-text">{step.title}</h2>
      <p className="mt-2 text-body text-pretty text-muted">{step.body}</p>
      {missing && <p className="mt-2 text-meta text-hold">{NOT_LOADED}</p>}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} disabled={index === 0} className={buttonClass('secondary', 'small')}>
          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
            <path d="M13 8H3m4-4L3 8l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        {atEnd ? (
          <>
            <Link href="/#try" onClick={onClose} className={buttonClass('secondary', 'small')}>
              Pick a role
            </Link>
            <button ref={primary} type="button" onClick={onNext} className={buttonClass('primary', 'small')}>Finish</button>
          </>
        ) : (
          <>
            <button ref={primary} type="button" onClick={onNext} className={buttonClass('primary', 'small')}>
              Next
              <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
                <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span aria-hidden className="ml-auto flex gap-1">
              {Array.from({ length: total }, (_, dot) => (
                <span key={dot} className={`size-1.5 rounded-full ${dot === index ? 'bg-text' : 'bg-faint'}`} />
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  );
});
