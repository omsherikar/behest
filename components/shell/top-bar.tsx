import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The floating glass bar at the top of every page, in the page's container: the wordmark on the
// left, a nav in the middle and actions on the right. From 1024 px it is one row with the nav
// centred; below that the nav takes a second row of its own and scrolls sideways if it must.

export function Wordmark({ className }: { className?: string }) {
  return (
    <Link href="/" aria-label="behest home" className={cn('rounded-md font-mono text-[1.0625rem] font-semibold tracking-[-0.03em] text-text', className)}>
      behest
    </Link>
  );
}

export function TopBar({
  nav,
  end,
  fixed = false,
  wideNavOnly = false,
}: {
  /** The bar's nav, such as the persona's sections or the landing page's sections. */
  nav?: ReactNode;
  /** What sits at the right end, such as the persona switcher or the demo button. */
  end?: ReactNode;
  /** Fixed over the page, for the landing page's hero; otherwise it sticks at the top as the page scrolls. */
  fixed?: boolean;
  /** Hides the nav under 1024 px instead of giving it a second row, for a nav a phone can do without. */
  wideNavOnly?: boolean;
}) {
  return (
    <header className={cn('inset-x-0 top-0 z-40 pt-3', fixed ? 'fixed' : 'sticky')}>
      {/* A fade from black behind the bar, so nothing scrolls into view in the gap above it. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-24 bg-linear-to-b from-black from-40% to-transparent" />
      <div className="container-page">
        <div className="glass flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[22px] p-2 pl-4 lg:grid lg:h-16 lg:grid-cols-[1fr_auto_1fr] lg:py-0 lg:pr-2.5 lg:pl-5">
          <Wordmark className="lg:justify-self-start" />
          {nav && (
            <div className={cn('order-last w-full min-w-0 justify-center lg:order-none lg:flex lg:w-auto', wideNavOnly ? 'hidden' : 'flex')}>{nav}</div>
          )}
          {end && <div className="flex min-w-0 items-center justify-end gap-2 lg:justify-self-end">{end}</div>}
        </div>
      </div>
    </header>
  );
}
