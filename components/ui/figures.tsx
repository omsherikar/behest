import type { ReactNode } from 'react';

// A row of figures over a page's grid, such as what the agent proposed and what was paid: each
// figure large, with its label under it. The label leads for a screen reader; the figure leads on
// screen. Two across on a phone, the given number across from 1024 px.

export function Figures({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <dl
      className={`mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-frame border border-line bg-line ${
        columns === 3 ? 'lg:grid-cols-3' : 'lg:grid-cols-4'
      }`}
    >
      {children}
    </dl>
  );
}

export function Figure({ label, children, tone = 'text-text' }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col bg-surface px-5 py-4 sm:px-6 sm:py-5">
      <dt className="order-last mt-1 text-meta text-muted">{label}</dt>
      <dd className={`text-[1.75rem] leading-9 font-medium tracking-[-0.03em] tabular-nums ${tone}`}>{children}</dd>
    </div>
  );
}
