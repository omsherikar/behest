import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

// A text link with a faint underline that a bright one slides over from the left on hover and on
// keyboard focus, so it reads as a link at rest. Adapted from the slide style of VengeanceUI's
// line-hover-link (https://www.vengenceui.com/r/line-hover-link.json), written with Tailwind instead
// of an injected style sheet.

export function LineHoverLink({ className, children, ...props }: ComponentProps<'a'>) {
  return (
    <a
      className={cn(
        'relative inline-flex w-fit items-center gap-1.5 font-medium text-text',
        'after:pointer-events-none after:absolute after:top-full after:left-0 after:h-px after:w-full after:bg-white/25',
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
