import type { AgWidgetApi, AgWidgetField } from 'ag-studio';
import type { ReactNode } from 'react';
import type { Verdict } from '@/lib/domain/verdict';

// Pieces the Behest widgets share: looking up the Studio fields a widget reads by id, reading
// values from query rows, and the verdict chip.

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

const VERDICT_STYLE: Record<Verdict, { chip: string; icon: string; path: string; label: string }> = {
  ALLOW: {
    chip: 'border-pp-success/30 bg-pp-success/10',
    icon: 'text-pp-success',
    path: 'm5 12.5 4.5 4.5L19 7.5',
    label: 'Paid within the mandate',
  },
  ASK: {
    chip: 'border-pp-warning/30 bg-pp-warning/10',
    icon: 'text-pp-warning',
    path: 'M9.2 9.3a2.9 2.9 0 1 1 4.1 2.6c-.8.4-1.3 1.1-1.3 2v.6M12 18h.01',
    label: 'Needed the buyer to approve',
  },
  BLOCK: {
    chip: 'border-pp-danger/30 bg-pp-danger/10',
    icon: 'text-pp-danger',
    path: 'M7 7l10 10M17 7 7 17',
    label: 'Blocked, nothing was paid',
  },
};

/** ALLOW green, ASK amber, BLOCK red: always an icon and the word, never color alone. */
export function VerdictChip({ verdict, count }: { verdict: Verdict; count?: number }) {
  const style = VERDICT_STYLE[verdict];
  return (
    <span
      title={style.label}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-semibold tracking-wide text-pp-ink ${style.chip}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`size-3.5 ${style.icon}`}>
        <path d={style.path} />
      </svg>
      {verdict}
      {count !== undefined && <span className="font-normal text-pp-muted tabular-nums">{count}</span>}
    </span>
  );
}

/** Shown in place of a widget's content when the report has none of the data it reads. */
export function WidgetMessage({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-semibold text-pp-navy">{title}</p>
      {children && <p className="max-w-xs text-sm text-pp-muted">{children}</p>}
    </div>
  );
}
