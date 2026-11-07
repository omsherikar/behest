import type { AgWidgetApi, AgWidgetData, AgWidgetDataFormat, AgWidgetField, AgWidgetParams } from 'ag-studio';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Verdict } from '@/lib/domain/verdict';

// Pieces the Behest widgets share: loading a widget's data, looking up the Studio fields a
// widget reads by id, reading values from query rows, and widget messages.

/** A widget's data: still loading, loaded, or failed to load. */
export type WidgetLoad<T> = { status: 'loading' } | { status: 'loaded'; value: T } | { status: 'failed' };

/**
 * Loads a widget's data whenever Studio passes new params (the mapping, the filters or the data
 * changed) and keeps Studio's overlay in step: a prominent spinner on the first load, a quiet one
 * on reloads, during which the previous data stays on screen, and Studio's "no data" overlay when
 * `isEmpty` says so. A failure is logged and reported as `failed`, for the widget to say so.
 * `load` and `isEmpty` must keep their identity across renders: pass module-level functions.
 */
export function useWidgetLoad<TWidget extends AgWidgetData<unknown, AgWidgetDataFormat<unknown>>, T>(
  params: AgWidgetParams<TWidget>,
  load: (params: AgWidgetParams<TWidget>) => Promise<T>,
  isEmpty?: (value: T) => boolean,
): WidgetLoad<T> {
  const [state, setState] = useState<WidgetLoad<T>>({ status: 'loading' });
  const loaded = useRef(false);

  useEffect(() => {
    let stale = false;
    params.widgetApi.setDisplayState('loading', { prominent: !loaded.current });
    load(params).then(
      (value) => {
        if (stale) return;
        loaded.current = true;
        setState({ status: 'loaded', value });
        params.widgetApi.setDisplayState(isEmpty?.(value) ? 'noData' : 'displayed');
      },
      (error: unknown) => {
        if (stale) return;
        console.error(`The ${params.widgetType} widget could not load its data.`, error);
        setState({ status: 'failed' });
        params.widgetApi.setDisplayState('displayed');
      },
    );
    return () => {
      stale = true;
    };
  }, [params, load, isEmpty]);

  return state;
}

/**
 * The Studio fields with the given ids (see WIDGET_FIELDS in ../studio/fields.ts), keyed by id, or
 * null if any is missing from the report's schema.
 */
export function findFields<const T extends string>(api: AgWidgetApi, ids: readonly T[]): Record<T, AgWidgetField> | null {
  const byId = new Map<string, AgWidgetField>(
    api.getSchema().flatMap((table) => table.fields.map((field) => [field.fieldId, field] as const)),
  );
  const found = ids.map((id) => [id, byId.get(id)] as const);
  if (found.some(([, field]) => !field)) return null;
  return Object.fromEntries(found) as Record<T, AgWidgetField>;
}

/** A date or datetime value from a query row, which Studio may hand back as a Date, a number or a string. */
export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Dollars, as Studio holds them, back to integer cents. */
export const toCents = (value: unknown) => (typeof value === 'number' ? Math.round(value * 100) : 0);

export const isVerdict = (value: unknown): value is Verdict => value === 'ALLOW' || value === 'ASK' || value === 'BLOCK';

/** Shown in place of a widget's content: why there is nothing to see. */
export function WidgetMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-semibold text-pp-navy">{title}</p>
      {children && <p className="max-w-xs text-sm text-pp-muted">{children}</p>}
    </div>
  );
}

/** Shown when a widget's data failed to load. The error is in the browser console. */
export function LoadFailed() {
  return (
    <WidgetMessage title="This widget could not load">
      Its data could not be read. Refresh the dashboard to try again.
    </WidgetMessage>
  );
}

/** Shown when the report's data lacks the fields a widget reads: a configuration problem, not an empty result. */
export function MissingFields({ widget }: { widget: string }) {
  return (
    <WidgetMessage title="Fields missing">
      This report&apos;s data lacks the fields the {widget} reads, so it has nothing to show.
    </WidgetMessage>
  );
}
