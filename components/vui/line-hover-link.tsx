import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// A text link whose underline slides in from the left on hover and on keyboard focus. Adapted from
// the slide style of VengeanceUI's line-hover-link (https://www.vengenceui.com/r/line-hover-link.json),
// written with Tailwind instead of an injected style sheet.

export function LineHoverLink({ className, children, ...props }: ComponentProps<'a'>) {
  return (
    <a
      className={cn(
        'relative inline-flex w-fit items-center gap-1.5 font-medium text-text',
        'before:pointer-events-none before:absolute before:top-full before:left-0 before:h-px before:w-full before:origin-right before:scale-x-0 before:bg-current before:transition-transform before:duration-300',
        'hover:before:origin-left hover:before:scale-x-100 focus-visible:before:origin-left focus-visible:before:scale-x-100',
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
}
