import type { ReactNode } from 'react';

// The top of every app page: its title, one line on what the page is for, and the page's primary
// action, right-aligned on the same row from 1024 px and under the line below that.

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
    <header className="mb-8 flex flex-col gap-5 lg:mb-10 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
      <div className="min-w-0 max-w-[68ch]">
        <h1 id={id} className="text-title font-medium text-balance text-text">
          {title}
        </h1>
        <p className="mt-2 text-lead text-pretty text-muted">{purpose}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
