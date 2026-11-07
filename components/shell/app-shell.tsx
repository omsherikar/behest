import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Persona } from '@/lib/session';
import { personaInfo } from '@/lib/ui/personas';
import { PersonaSwitcher } from './persona-switcher';
import { SectionNav } from './section-nav';

// The one frame around every page: a top bar with the wordmark and the persona switcher, the
// persona's section nav under it, and the page, left aligned and at most 1200 px wide. The header
// sticks to the top while the page scrolls. Without a persona (the home page, before one is
// picked) the header holds the wordmark alone.

/** The header's height: a 3rem top bar, a 2.75rem nav and a 1px border. */
const SHELL_HEIGHT = '[--shell-h:5.8125rem]';
const SHELL_HEIGHT_BARE = '[--shell-h:3.0625rem]';

/**
 * For a page whose content should fill the window below the header, such as one built around a
 * grid: at least 36rem tall, so the grid keeps room on a phone, and otherwise exactly the space
 * left under the header and the page's padding.
 */
export const fillWindow = 'flex h-[max(36rem,calc(100dvh-var(--shell-h)-3rem))] flex-col';

export function AppShell({ persona, children }: { persona?: Persona; children: ReactNode }) {
  const info = persona ? personaInfo(persona) : null;
  return (
    <div className={`flex min-h-dvh flex-col ${info ? SHELL_HEIGHT : SHELL_HEIGHT_BARE}`}>
      <a
        href="#content"
        className="sr-only rounded-control bg-action px-3 py-2 font-medium text-on-fill focus:not-sr-only focus:fixed focus:top-2 focus:left-4 focus:z-50"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex h-12 w-full max-w-[1200px] items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/"
            aria-label="behest home"
            className="-mx-1 rounded-control px-1 font-mono text-[1.0625rem] font-semibold tracking-tight text-text"
          >
            behest
          </Link>
          {persona && <PersonaSwitcher current={persona} />}
        </div>
        {info && (
          <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6">
            <SectionNav items={info.nav} label={`${info.name} pages`} />
          </div>
        )}
      </header>
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col focus:outline-none">
        <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col px-4 py-6 sm:px-6">{children}</div>
      </main>
    </div>
  );
}
