'use client';

// The dashboard's rows from GET /api/dashboard/data, which scopes them to the signed-in persona.
// A refresh keeps the current rows on screen until the new ones arrive; if it fails, the old rows
// stay and the failure is reported alongside them.

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DashboardData } from '@/lib/dashboard/scope';

export type DashboardDataState =
  | { status: 'loading' }
  | { status: 'failed'; error: Error }
  | { status: 'ready'; data: DashboardData; refreshing: boolean; refreshError: string | null };

const SIGNED_OUT = Symbol('signed out');

async function fetchDashboardData(signal?: AbortSignal): Promise<DashboardData | typeof SIGNED_OUT> {
  const response = await fetch('/api/dashboard/data', { cache: 'no-store', signal });
  if (response.status === 401) return SIGNED_OUT;
  if (!response.ok) throw new Error(`The dashboard data request failed with status ${response.status}.`);
  return (await response.json()) as DashboardData;
}

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export function useDashboardData() {
  const router = useRouter();
  const [state, setState] = useState<DashboardDataState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboardData(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        // The session cookie expired or was cleared: back to the persona picker.
        if (data === SIGNED_OUT) router.replace('/');
        else setState({ status: 'ready', data, refreshing: false, refreshError: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'failed', error: asError(error) });
      });
    return () => controller.abort();
  }, [router]);

  const refresh = async () => {
    setState((current) => (current.status === 'ready' ? { ...current, refreshing: true, refreshError: null } : current));
    try {
      const data = await fetchDashboardData();
      if (data === SIGNED_OUT) router.replace('/');
      else setState({ status: 'ready', data, refreshing: false, refreshError: null });
    } catch (error) {
      setState((current) =>
        current.status === 'ready' ? { ...current, refreshing: false, refreshError: asError(error).message } : current,
      );
    }
  };

  return { state, refresh };
}
