'use client';

// The decision ledger: every purchase the agent proposed, newest first, with its verdict chip and
// the gate rules that asked or blocked it. It is an AG Grid inside a Studio widget, so it follows
// the report's filters, and clicking a row cross-filters the rest of the page (the receipt card
// shows that purchase's receipt). Cross-filters only highlight rows here, so every purchase stays
// in reach. The Columns data mapping adds or removes columns.

import { useMemo } from 'react';
import {
  studioGridTheme,
  type AgWidgetDataFormat,
  type AgWidgetField,
  type AgWidgetFieldReference,
  type AgWidgetParams,
} from 'ag-studio';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  RowAutoHeightModule,
  RowStyleModule,
  type ColDef,
  type RowClickedEvent,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import type { Verdict } from '@/lib/domain/verdict';
import { WIDGET_FIELDS } from '../studio/fields';
import { findFields, isVerdict, LoadFailed, MissingFields, useWidgetLoad, VerdictChip } from './shared';

export type LedgerStyle = {
  /** Show the rules that asked or blocked each purchase. */
  showReasons?: boolean;
  /** Show the count of each verdict above the ledger. */
  showVerdictMix?: boolean;
};

export interface LedgerDef {
  type: 'behest-ledger';
  dataMapping: { columns: AgWidgetFieldReference[] };
  format?: AgWidgetDataFormat<LedgerStyle>;
}

type Reason = { rule: string; result: 'Ask' | 'Block'; detail: string };
type LedgerRow = { id: string; verdict: Verdict; values: Record<string, unknown>; reasons: Reason[] };
/**
 * `highlighted` holds the purchases a cross-filter selects, or null when none is active.
 * `hasReasons` is false when the report has no decision outcomes, as for the seller.
 */
type Ledger = { columns: AgWidgetField[]; rows: LedgerRow[]; highlighted: Set<string> | null; hasReasons: boolean };

const F = WIDGET_FIELDS;
const LEDGER_FIELDS = [F.purchaseId, F.purchaseVerdict, F.purchaseCreatedAt] as const;
const REASON_FIELDS = [F.outcomePurchaseId, F.outcomePosition, F.outcomeRule, F.outcomeResult, F.outcomeDetail] as const;
const VERDICTS: Verdict[] = ['ALLOW', 'ASK', 'BLOCK'];
const MIX_FILL: Record<Verdict, string> = { ALLOW: 'bg-pp-success', ASK: 'bg-pp-warning', BLOCK: 'bg-pp-danger' };

const modules = [ClientSideRowModelModule, RowAutoHeightModule, RowStyleModule, CellStyleModule];

// Narrowest a mapped column may get, so a date or an amount never truncates.
const MIN_WIDTH: Record<AgWidgetField['dataType'], number> = {
  string: 110,
  number: 88,
  boolean: 80,
  date: 112,
  datetime: 148,
};
const CELL_CLASS = 'leading-5 !py-2.5';

/**
 * The ledger's rows: the purchases in view, and each one's non-passing decision outcomes in order.
 * Null when the report lacks the purchase fields the ledger needs.
 */
async function loadLedger(params: AgWidgetParams<LedgerDef>): Promise<Ledger | null> {
  const { widgetApi, dataMapping } = params;
  const f = findFields(widgetApi, LEDGER_FIELDS);
  if (!f) return null;
  // Optional: the seller's report has no decision outcomes, and its ledger simply shows none.
  const r = findFields(widgetApi, REASON_FIELDS);
  const id = f[F.purchaseId];
  const verdict = f[F.purchaseVerdict];
  const columns = (dataMapping.columns ?? []).filter((c) => c.key !== id.key && c.key !== verdict.key);
  const queryFields = [id, verdict, f[F.purchaseCreatedAt], ...columns].filter(
    (field, index, all) => all.findIndex((other) => other.key === field.key) === index,
  );

  const [main, outcomes] = await Promise.all([
    widgetApi.getData(
      { fields: queryFields, sort: [{ field: f[F.purchaseCreatedAt], direction: 'desc' }] },
      { queryId: 'rows', crossFilter: 'highlight' },
    ),
    // Reasons are looked up by purchase, so they ignore filters: the rows query already decides
    // which purchases are shown.
    r
      ? widgetApi.getData(
          { fields: REASON_FIELDS.map((fieldId) => r[fieldId]), sort: [{ field: r[F.outcomePosition], direction: 'asc' }] },
          { queryId: 'reasons', filter: false, crossFilter: 'none' },
        )
      : null,
  ]);

  const reasons = new Map<string, Reason[]>();
  if (r && outcomes) {
    for (const row of outcomes.results.rows) {
      const result = row[r[F.outcomeResult].key];
      if (result !== 'Ask' && result !== 'Block') continue;
      const purchaseId = String(row[r[F.outcomePurchaseId].key]);
      reasons.set(purchaseId, [
        ...(reasons.get(purchaseId) ?? []),
        { rule: String(row[r[F.outcomeRule].key]), result, detail: String(row[r[F.outcomeDetail].key] ?? '') },
      ]);
    }
  }

  const rows = main.results.rows.flatMap((row): LedgerRow[] => {
    const value = row[verdict.key];
    if (!isVerdict(value)) return [];
    const purchaseId = String(row[id.key]);
    return [{ id: purchaseId, verdict: value, values: row, reasons: reasons.get(purchaseId) ?? [] }];
  });
  const highlighted = main.crossFilter ? new Set(main.crossFilter.rows.map((row) => String(row[id.key]))) : null;
  return { columns, rows, highlighted, hasReasons: r !== null };
}

// Studio shows its own "no data" overlay when no purchase is in view.
const noPurchases = (ledger: Ledger | null) => ledger !== null && ledger.rows.length === 0;

function VerdictCell({ data }: CustomCellRendererProps<LedgerRow>) {
  return data ? <VerdictChip verdict={data.verdict} /> : null;
}

const RESULT_TAG: Record<Reason['result'], string> = {
  Ask: 'bg-pp-warning/10 text-pp-ink ring-pp-warning/40',
  Block: 'bg-pp-danger/10 text-pp-ink ring-pp-danger/40',
};

function ReasonsCell({ data }: CustomCellRendererProps<LedgerRow>) {
  if (!data) return null;
  if (data.reasons.length === 0) {
    return (
      <span className="block py-2.5 leading-5 text-pp-muted">
        {data.verdict === 'ALLOW' ? 'Every rule passed' : 'No rule reason recorded'}
      </span>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5 py-2.5 leading-5 whitespace-normal">
      {data.reasons.map((reason) => (
        <li key={reason.rule} className="flex items-baseline gap-2">
          <span className={`shrink-0 rounded px-1.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${RESULT_TAG[reason.result]}`}>
            {reason.result}
          </span>
          <span>
            <span className="font-semibold text-pp-navy">{reason.rule}.</span> <span className="text-pp-ink">{reason.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function VerdictMix({ rows }: { rows: LedgerRow[] }) {
  const counts = VERDICTS.map((verdict) => ({ verdict, count: rows.filter((r) => r.verdict === verdict).length }));
  const label = counts.map(({ verdict, count }) => `${count} ${verdict}`).join(', ');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 pb-3">
      <div className="flex items-center gap-2">
        {counts.map(({ verdict, count }) => (
          <VerdictChip key={verdict} verdict={verdict} count={count} />
        ))}
      </div>
      <div role="img" aria-label={`Verdicts: ${label}`} className="flex h-2 min-w-24 flex-1 gap-0.5 overflow-hidden rounded-full">
        {counts
          .filter(({ count }) => count > 0)
          .map(({ verdict, count }) => (
            <span key={verdict} className={`h-full rounded-full ${MIX_FILL[verdict]}`} style={{ flexGrow: count }} />
          ))}
      </div>
    </div>
  );
}

export function LedgerWidget(params: AgWidgetParams<LedgerDef>) {
  const { widgetApi, format } = params;
  const load = useWidgetLoad(params, loadLedger, noPurchases);
  const ledger = load.status === 'loaded' ? load.value : null;
  const showReasons = format?.style?.showReasons !== false && ledger?.hasReasons !== false;
  const showVerdictMix = format?.style?.showVerdictMix !== false;

  const idField = useMemo(() => findFields(widgetApi, [F.purchaseId])?.[F.purchaseId], [widgetApi]);
  const highlighted = ledger?.highlighted ?? null;

  const columnDefs = useMemo((): ColDef<LedgerRow>[] => {
    const mapped = (ledger?.columns ?? []).map((field): ColDef<LedgerRow> => {
      const text = field.dataType === 'string';
      return {
        colId: field.key,
        headerName: widgetApi.getFieldName(field),
        valueGetter: ({ data }) => data?.values[field.key],
        valueFormatter: ({ value }) => widgetApi.formatFieldValue(field, value),
        flex: text ? 2 : 1,
        minWidth: MIN_WIDTH[field.dataType],
        wrapText: true,
        autoHeight: true,
        // Every cell starts on the same line as the verdict chip and the first reason.
        // The column's own cellClass replaces the right alignment the column type would add.
        cellClass: field.dataType === 'number' ? `${CELL_CLASS} ag-right-aligned-cell` : CELL_CLASS,
        type: field.dataType === 'number' ? 'rightAligned' : undefined,
      };
    });
    return [
      {
        colId: 'verdict',
        headerName: 'Verdict',
        field: 'verdict',
        cellRenderer: VerdictCell,
        cellClass: '!py-2',
        width: 108,
        minWidth: 108,
        maxWidth: 108,
      },
      ...mapped,
      ...(showReasons
        ? [{ colId: 'reasons', headerName: 'Why', cellRenderer: ReasonsCell, flex: 4, minWidth: 260, autoHeight: true, sortable: false }]
        : []),
    ];
  }, [ledger, showReasons, widgetApi]);

  const onRowClicked = ({ data, event }: RowClickedEvent<LedgerRow>) => {
    if (!data || !idField) return;
    const mouse = event as MouseEvent | null;
    widgetApi.toggleCrossFilter({
      type: 'value',
      field: idField,
      value: data.id,
      group: 0,
      reset: !(mouse?.metaKey || mouse?.ctrlKey),
    });
  };

  if (load.status === 'loading') return null;
  if (load.status === 'failed') return <LoadFailed />;
  if (!ledger) return <MissingFields widget="decision ledger" />;
  if (ledger.rows.length === 0) return null;
  return (
    <div className="flex h-full flex-col px-2 pb-2 font-paypal">
      {showVerdictMix && <VerdictMix rows={ledger.rows} />}
      <div className="min-h-0 flex-1">
        <AgGridProvider modules={modules}>
          <AgGridReact<LedgerRow>
            theme={studioGridTheme}
            rowData={ledger.rows}
            columnDefs={columnDefs}
            getRowId={({ data }) => data.id}
            defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
            rowClassRules={{
              '!bg-pp-highlight': ({ data }) => !!data && !!highlighted?.has(data.id),
              'opacity-45': ({ data }) => !!data && !!highlighted && !highlighted.has(data.id),
            }}
            onRowClicked={onRowClicked}
            suppressCellFocus
          />
        </AgGridProvider>
      </div>
      <p className="px-1 pt-2 text-xs text-pp-muted">Click a purchase to filter the page to it; Ctrl or Cmd click to add more.</p>
    </div>
  );
}
