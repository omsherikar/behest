'use client';

import { shortId } from '@/lib/ui/format';
import { CopyButton } from './copy-button';

// A value a person copies or compares, such as a receipt id, a key id or a hash: shortened in Plex
// Mono for a glance, whole for a screen reader and on hover, and copied whole with its button.

/** The label inside a sentence: "Receipt id" becomes "receipt id", but "PayPal order id" stays. */
function inSentence(label: string): string {
  return /^[A-Z][a-z]*(?=\s|$)/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

export function ProofId({
  value,
  label,
  full = false,
  className = '',
}: {
  value: string;
  /** What the value is, in sentence case, such as "Receipt id" or "Policy hash". */
  label: string;
  /** Shows the whole value, wrapped, instead of its start and end. */
  full?: boolean;
  className?: string;
}) {
  const shown = full ? value : shortId(value);
  return (
    <span className={`inline-flex max-w-full items-center gap-2 align-middle ${className}`}>
      <span className={`min-w-0 font-mono text-meta text-text ${full ? 'break-all' : 'whitespace-nowrap'}`} title={full ? undefined : value}>
        <span className="sr-only">
          {label}: {value}
        </span>
        <span aria-hidden>{shown}</span>
      </span>
      <CopyButton value={value} label={inSentence(label)} />
    </span>
  );
}
