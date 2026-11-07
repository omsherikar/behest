import type { ReactNode } from 'react';

// The top of every page: its title and one sentence on what the page is for, with room for an
// action on the right.

export function PageHeader({
  title,
  purpose,
  id,
  actions,
}: {
  title: string;
  /** One sentence: what this page is for. */
  purpose: ReactNode;
  /** The heading's id, for a grid or a region the heading names. */
  id?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-[75ch]">
        <h1 id={id} className="text-title font-semibold text-text">
          {title}
        </h1>
        <p className="mt-1 text-body text-muted">{purpose}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </header>
  );
}
