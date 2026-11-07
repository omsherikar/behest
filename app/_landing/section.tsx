import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// One section of the home page: a small mono pill with the section's number and name, a statement
// in two tones (a white line, then a grey one), an optional lead, and the content. `split` puts the
// statement in a left column and the content beside it from 1024 px, as the FAQ does.

export function SectionIndex({ index, name }: { index: number; name: string }) {
  return (
    <p className="flex items-center gap-3">
      <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-white/20 px-1.5 font-mono text-[0.6875rem] text-text tabular-nums">
        {String(index).padStart(2, '0')}
      </span>
      <span className="font-mono text-meta text-muted">{name}</span>
    </p>
  );
}

export function Statement({ id, lines: [first, second], className }: { id: string; lines: [string, string]; className?: string }) {
  return (
    <h2 id={id} className={cn('text-section font-medium text-balance text-text', className)}>
      <span className="block">{first}</span>
      <span className="block text-muted">{second}</span>
    </h2>
  );
}

export function Section({
  id,
  index,
  name,
  statement,
  lead,
  split = false,
  className,
  children,
}: {
  id: string;
  index: number;
  name: string;
  statement: [string, string];
  lead?: ReactNode;
  split?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const header = (
    <div className={split ? 'lg:sticky lg:top-28 lg:self-start' : undefined}>
      <SectionIndex index={index} name={name} />
      <Statement id={`${id}-title`} lines={statement} className={cn('mt-6', split ? 'max-w-[14ch]' : 'max-w-[22ch]')} />
      {lead && <p className="mt-6 max-w-[58ch] text-lead text-pretty text-muted">{lead}</p>}
    </div>
  );
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('scroll-mt-20 py-14 sm:py-16 lg:py-20', className)}>
      <div className="container-page">
        {split ? (
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-5">{header}</div>
            <div className="min-w-0 lg:col-span-7">{children}</div>
          </div>
        ) : (
          <>
            {header}
            <div className="mt-12 lg:mt-16">{children}</div>
          </>
        )}
      </div>
    </section>
  );
}
