import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// A card that names one thing, shows it working and says it in a sentence: a header with an optional
// numbered pill or icon and the title, a live mini interface in the middle, and one sentence under
// it. Adapted from the FeatCard of VengeanceUI's agent-bento-grid
// (https://www.vengenceui.com/r/agent-bento-grid.json): our tokens, a header band lit from its top
// left as on argus.omstudio.tech, and no entrance animation.

export function FeatureCard({
  title,
  description,
  index,
  icon,
  meta,
  children,
  className,
  as: Tag = 'article',
}: {
  title: string;
  description: ReactNode;
  /** The card's place in a sequence, shown as a small mono pill. Only for content that is a sequence. */
  index?: number;
  /** A small icon beside the title, for a card that is not part of a sequence. */
  icon?: ReactNode;
  /** A short machine value under the title, such as an API path. */
  meta?: ReactNode;
  /** The live mini interface. Without one, the card is the header and the sentence. */
  children?: ReactNode;
  className?: string;
  as?: 'article' | 'li' | 'div';
}) {
  return (
    <Tag className={cn('flex min-w-0 flex-col overflow-hidden rounded-frame border border-line bg-surface shadow-[var(--highlight)]', className)}>
      <div className="border-b border-line bg-linear-to-br from-white/[0.06] to-transparent px-6 pt-6 pb-5">
        {index !== undefined && (
          <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-white/20 px-1.5 font-mono text-[0.6875rem] text-text tabular-nums">
            {String(index).padStart(2, '0')}
          </span>
        )}
        <h3 className={cn('flex items-center gap-2.5 text-heading font-medium text-text', index !== undefined && 'mt-5')}>
          {icon && <span className="flex size-5 shrink-0 items-center justify-center text-muted [&>svg]:size-5">{icon}</span>}
          {title}
        </h3>
        {meta && <p className="mt-1.5 font-mono text-meta break-all text-muted">{meta}</p>}
      </div>
      {children && <div className="flex min-h-48 flex-1 items-center justify-center px-5 py-6">{children}</div>}
      <p className={cn('px-6 pb-6 text-body text-muted', children ? 'pt-0' : 'pt-5')}>{description}</p>
    </Tag>
  );
}
