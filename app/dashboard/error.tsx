'use client';

import { useEffect } from 'react';
import { AlertIcon } from './components/ui/icons';
import { AppShell } from './components/app-shell';
import { SidebarSkeleton } from './components/skeleton';
import { Button } from './components/ui/ui';

// Shown when the dashboard's data can't be loaded. Try again loads it afresh.
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AppShell sidebar={<SidebarSkeleton />}>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-lg rounded-lg border border-pp-border bg-pp-surface p-8 text-center">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-pp-danger/10 text-pp-danger">
            <AlertIcon className="size-7" />
          </span>
          <h1 className="mt-4 text-2xl font-semibold text-pp-navy">We couldn&apos;t load the dashboard</h1>
          <p className="mt-2 text-[15px] text-pp-muted">
            The dashboard data didn&apos;t load. Check that the database is reachable and its migrations have run, then try
            again.
          </p>
          {error.message && (
            <p className="mt-4 break-words rounded-lg bg-pp-canvas px-4 py-3 text-left font-mono text-xs text-pp-muted">
              {error.message}
              {error.digest && <span className="block pt-1">Reference: {error.digest}</span>}
            </p>
          )}
          <Button variant="primary" className="mt-6" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
