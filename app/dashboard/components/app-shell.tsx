'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { DEMO_BUYER_NAME, DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import type { Persona } from '@/lib/session';
import { BellIcon, HelpIcon, MenuIcon, SwitchIcon } from './ui/icons';
import { AgStudioLogo } from './ui/logo';

// The app frame, laid out like the PayPal Developer Dashboard: a white top bar, a left sidebar
// and a light canvas. Shared by the dashboard, its loading skeleton and its error page. On narrow
// screens the top bar keeps only the essentials and the sidebar becomes a drawer behind a menu
// button, so the report gets the whole width.

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
    <div className="flex min-w-0 items-center gap-3">
      <Link href="/" aria-label="behest home" className="rounded-control font-mono text-[1.0625rem] font-semibold tracking-tight text-text">
        behest
      </Link>
      <span className="hidden h-6 w-px bg-pp-border sm:block" aria-hidden />
      <AgStudioLogo className="-ml-3 hidden h-12 w-auto sm:block" />
      <span className="hidden h-6 w-px bg-pp-border lg:block" aria-hidden />
      <span className="hidden items-baseline gap-1 text-xs text-pp-muted lg:flex">
        powered by <PayPalWordmark className="text-base" /> APIs
      </span>
    </div>
  );
}

function TopBar({ viewer, onMenu }: { viewer?: Viewer; onMenu: () => void }) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b border-pp-border bg-pp-surface px-4 sm:gap-6 sm:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open reports"
        title="Reports"
        className="-ml-1 inline-flex size-9 shrink-0 items-center justify-center rounded-full text-pp-navy hover:bg-pp-highlight md:hidden"
      >
        <MenuIcon />
      </button>
      <BrandLockup />
      <div className="ml-auto flex shrink-0 items-center gap-1 text-pp-navy">
        <span className="hidden size-9 items-center justify-center rounded-full sm:inline-flex" title="Help">
          <HelpIcon />
        </span>
        <span className="hidden size-9 items-center justify-center rounded-full sm:inline-flex" title="Notifications">
          <BellIcon />
        </span>
        {viewer && (
          <span className="ml-2 flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-pp-highlight text-sm font-semibold text-pp-ink">
              {viewer.initials}
            </span>
            <span className="hidden flex-col leading-tight sm:flex">
              <span className="text-sm font-semibold">{viewer.name}</span>
              <span className="text-xs text-pp-muted">{viewer.role}</span>
            </span>
            <Link
              href="/"
              aria-label="Switch persona"
              title="Switch persona"
              className="inline-flex size-9 items-center justify-center rounded-full text-sm font-semibold text-pp-blue hover:bg-pp-highlight sm:ml-2 sm:size-auto sm:px-3 sm:py-1.5"
            >
              <SwitchIcon className="size-5 sm:hidden" />
              <span className="hidden sm:inline">Switch persona</span>
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
  navKey = '',
  children,
}: {
  sidebar: ReactNode;
  viewer?: Viewer;
  /** Identifies what the sidebar has open, such as the report and page; the drawer closes when it changes. */
  navKey?: string;
  children: ReactNode;
}) {
  // The drawer (narrow screens only) closes whenever the report or page changes, so choosing a
  // page in it closes it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [shownKey, setShownKey] = useState(navKey);
  if (shownKey !== navKey) {
    setShownKey(navKey);
    setDrawerOpen(false);
  }
  const close = () => setDrawerOpen(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawerOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    <div className="flex h-dvh flex-col bg-pp-canvas font-paypal text-pp-ink">
      <TopBar viewer={viewer} onMenu={() => setDrawerOpen((open) => !open)} />
      <div className="flex min-h-0 flex-1">
        {drawerOpen && <div className="fixed inset-0 z-30 bg-black/60 md:hidden" onClick={close} aria-hidden />}
        <nav
          className={`w-64 shrink-0 flex-col border-r border-pp-border bg-pp-surface md:static md:z-auto md:flex md:shadow-none ${
            drawerOpen ? 'fixed inset-y-0 left-0 z-40 flex shadow-xl' : 'hidden'
          }`}
          aria-label="Reports"
        >
          {sidebar}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
