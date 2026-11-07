'use client';

import { useEffect, useState } from 'react';

// Copies a value to the clipboard. The button says "Copied" for two seconds afterwards, and a
// screen reader hears the same through a polite status. If the browser refuses (an insecure page,
// a denied permission), it says "Copy failed" instead.

type Outcome = 'idle' | 'copied' | 'failed';

const WORDS: Record<Outcome, string> = { idle: 'Copy', copied: 'Copied', failed: 'Copy failed' };

export function CopyButton({ value, label, className = '' }: { value: string; /** What is copied, such as "receipt id". */ label: string; className?: string }) {
  const [outcome, setOutcome] = useState<Outcome>('idle');

  useEffect(() => {
    if (outcome === 'idle') return;
    const timer = setTimeout(() => setOutcome('idle'), 2000);
    return () => clearTimeout(timer);
  }, [outcome]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setOutcome('copied');
    } catch {
      setOutcome('failed');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`${WORDS[outcome]} ${label}`}
        className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-control border px-1.5 font-sans text-meta transition-colors ${
          outcome === 'copied'
            ? 'border-seal/40 bg-seal/12 text-seal'
            : outcome === 'failed'
              ? 'border-stop/40 bg-stop/12 text-stop'
              : 'border-line text-muted hover:border-line-strong hover:bg-raised hover:text-text'
        } ${className}`}
      >
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          {outcome === 'copied' ? (
            <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </>
          )}
        </svg>
        {WORDS[outcome]}
      </button>
      <span role="status" className="sr-only">
        {outcome === 'copied' ? `${label} copied` : outcome === 'failed' ? `Could not copy the ${label}` : ''}
      </span>
    </>
  );
}
