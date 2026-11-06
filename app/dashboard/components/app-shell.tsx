'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { DEMO_BUYER_NAME, DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import type { Persona } from '@/lib/session';
import { BellIcon, HelpIcon } from './ui/icons';
import { AgStudioLogo } from './ui/logo';

// The app frame, laid out like the PayPal Developer Dashboard: a white top bar, a left sidebar
// and a light canvas. Shared by the dashboard, its loading skeleton and its error page.

/** Who is viewing the dashboard, as shown in the top bar. */
export type Viewer = { initials: string; name: string; role: string };

export function viewerFor(persona: Persona): Viewer {
  if (persona === 'buyer') return { initials: DEMO_BUYER_NAME[0], name: DEMO_BUYER_NAME, role: 'Buyer' };
  if (persona === 'seller') return { initials: DEMO_SELLER_SLUG[0].toUpperCase(), name: DEMO_SELLER_SLUG, role: 'Seller' };
  return { initials: 'OP', name: 'Behest operator', role: 'Operator' };
}

function PayPalWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-bold italic tracking-tight ${className}`}>
      <span className="text-pp-blue-dark">Pay</span>
      <span className="text-pp-sky">Pal</span>
    </span>
  );
}

function BrandLockup() {
  return (
    <div className="flex items-center gap-3">
      <span className="text-2xl font-bold tracking-tight text-pp-navy">Behest</span>
      <span className="h-6 w-px bg-pp-border" aria-hidden />
      <AgStudioLogo className="-ml-3 h-12 w-auto" />
      <span className="h-6 w-px bg-pp-border" aria-hidden />
      <span className="flex items-baseline gap-1 text-xs text-pp-muted">
        powered by <PayPalWordmark className="text-base" /> APIs
      </span>
    </div>
  );
}

function TopBar({ viewer }: { viewer?: Viewer }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-6 border-b border-pp-border bg-white px-6">
      <BrandLockup />
      <div className="ml-auto flex items-center gap-1 text-pp-navy">
        <span className="inline-flex size-9 items-center justify-center rounded-full" title="Help">
          <HelpIcon />
        </span>
        <span className="inline-flex size-9 items-center justify-center rounded-full" title="Notifications">
          <BellIcon />
        </span>
        {viewer && (
          <span className="ml-2 flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-pp-navy text-sm font-semibold text-white">
              {viewer.initials}
            </span>
            <span className="hidden flex-col leading-tight sm:flex">
              <span className="text-sm font-semibold">{viewer.name}</span>
              <span className="text-xs text-pp-muted">{viewer.role}</span>
            </span>
            <Link href="/" className="ml-2 rounded-full px-3 py-1.5 text-sm font-semibold text-pp-blue hover:bg-pp-highlight">
              Switch persona
            </Link>
          </span>
        )}
      </div>
    </header>
  );
}

export function AppShell({
  sidebar,
  viewer,
  children,
}: {
  sidebar: ReactNode;
  viewer?: Viewer;
  children: ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-pp-canvas font-paypal text-pp-ink">
      <TopBar viewer={viewer} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-64 shrink-0 flex-col border-r border-pp-border bg-white" aria-label="Reports">
          {sidebar}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
