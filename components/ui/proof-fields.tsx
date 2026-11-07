import type { ReactNode } from 'react';

// The facts behind one step of a trace, as label and value pairs: a hash, an id, a time. Labels sit
// beside their values on wide screens and above them on a phone.

export type ProofField = { label: string; value: ReactNode };

export function ProofFields({ fields }: { fields: readonly ProofField[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
      {fields.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-meta text-muted">{label}</dt>
          <dd className="mb-1 min-w-0 text-body break-words text-text sm:mb-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
