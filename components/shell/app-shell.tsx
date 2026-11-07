import type { ReactNode } from 'react';
import type { Persona } from '@/lib/session';
import { personaInfo } from '@/lib/ui/personas';
import { PersonaSwitcher } from './persona-switcher';
import { SectionNav } from './section-nav';
import { TopBar } from './top-bar';

// The one frame around every app page: the floating glass top bar with the wordmark, the persona's
// sections and the persona switcher, then the page in the 1200 px container. The bar sticks to the
// top while the page scrolls.

export function AppShell({ persona, children }: { persona: Persona; children: ReactNode }) {
  const info = personaInfo(persona);
  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#content"
        className="sr-only rounded-full bg-text px-4 py-2 font-medium text-on-fill focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50"
      >
        Skip to content
      </a>
      <TopBar nav={<SectionNav items={info.nav} label={`${info.name} pages`} />} end={<PersonaSwitcher current={persona} />} />
      <main id="content" tabIndex={-1} className="flex flex-1 flex-col focus:outline-none">
        <div className="container-page flex flex-1 flex-col py-8">{children}</div>
      </main>
    </div>
  );
}
