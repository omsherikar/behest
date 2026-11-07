'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { useState } from 'react';
import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { statusWords } from '@/lib/buyer-pages/words';
import { formatUsd } from '@/lib/domain/money';
import { shortId } from '@/lib/ui/format';
import { SellerGrid } from '@/app/seller/seller-grid';
import { focusStep, PurchaseTrace } from '@/components/purchase/purchase-trace';
import { MiniTrace } from '@/components/ui/mini-trace';
import { Money } from '@/components/ui/money';
import { SidePanel } from '@/components/ui/side-panel';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { WhatWouldChange } from '@/components/ui/what-would-change';

// Every purchase the buyer's agent proposed, newest first: its verdict, its authority trace in
// small, where it stands in plain words, why it was not simply allowed and its receipt. Clicking a
// row, or pressing Enter on it, opens a side panel with the full trace and the proof behind each
// step, where the receipt can be verified. Seller names and reasons may be a seller's text, so
// every cell is rendered as text.

// 7 Nov 2026, 09:00, in UTC as the column header says.
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

function VerdictCell({ data }: CustomCellRendererProps<PurchaseDetail>) {
  return data ? <VerdictBadge verdict={data.verdict} /> : null;
}

function TraceCell({ data }: CustomCellRendererProps<PurchaseDetail>) {
  return data ? <MiniTrace states={data.trace} /> : null;
}

function ReasonsCell({ data }: CustomCellRendererProps<PurchaseDetail>) {
  if (!data || data.reasons.length === 0) return null;
  // The grid's own styles set the cell's line height to the row height, so the list sets its own.
  return (
    <ul className="list-disc space-y-1 py-2 pl-4 leading-snug">
      {data.reasons.map((reason, index) => (
        // Two reasons can read the same.
        <li key={index}>{reason}</li>
      ))}
    </ul>
  );
}

const columns: ColDef<PurchaseDetail>[] = [
  {
    field: 'createdAt',
    headerName: 'Time (UTC)',
    sort: 'desc',
    cellClass: 'font-mono',
    valueFormatter: ({ value }: ValueFormatterParams<PurchaseDetail, string>) => (value ? dateTime.format(new Date(value)) : ''),
    getQuickFilterText: ({ value }) => (value ? dateTime.format(new Date(value)) : ''),
  },
  { field: 'seller', headerName: 'Seller' },
  {
    field: 'totalCents',
    headerName: 'Total',
    type: 'rightAligned',
    cellClass: 'font-mono',
    valueFormatter: ({ value }: ValueFormatterParams<PurchaseDetail, number | null>) =>
      typeof value === 'number' ? formatUsd(value) : 'Not priced',
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.totalCents === 'number' ? data.totalCents / 100 : null),
  },
  { field: 'verdict', headerName: 'Verdict', cellRenderer: VerdictCell },
  { colId: 'trace', headerName: 'Trace', cellRenderer: TraceCell, filter: false, sortable: false },
  { colId: 'status', headerName: 'Status', valueGetter: ({ data }) => (data ? statusWords(data.status) : '') },
  {
    colId: 'reasons',
    headerName: 'Reasons',
    valueGetter: ({ data }) => data?.reasons.join(' ') ?? '',
    cellRenderer: ReasonsCell,
    // Reasons can run long, so they wrap in a column of their own width instead of setting it.
    width: 320,
    suppressAutoSize: true,
    wrapText: true,
    autoHeight: true,
  },
  {
    colId: 'receipt',
    headerName: 'Receipt id',
    cellClass: 'font-mono',
    valueGetter: ({ data }) => data?.receipt?.id ?? null,
    valueFormatter: ({ value }: ValueFormatterParams<PurchaseDetail, string | null>) => (value ? shortId(value) : 'None'),
  },
];

/** "2 × Turmeric, 100 g and 1 more item". */
function itemsLine(items: PurchaseDetail['items']): string {
  if (items.length === 0) return 'No cart';
  const [first, ...rest] = items;
  return `${first.quantity} × ${first.title}${rest.length === 0 ? '' : ` and ${rest.length} more ${rest.length === 1 ? 'item' : 'items'}`}`;
}

/** The side panel for one purchase: its trace with the proof behind each step, why, and what would change. */
function DetailPanel({ detail, onClose }: { detail: PurchaseDetail | null; onClose: () => void }) {
  return (
    <SidePanel
      open={detail !== null}
      onClose={onClose}
      title={detail ? itemsLine(detail.items) : ''}
      subtitle={detail && `From ${detail.seller}, proposed ${dateTime.format(new Date(detail.createdAt))} UTC`}
    >
      {detail && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <VerdictBadge verdict={detail.verdict} />
            <span className="font-medium text-text">{statusWords(detail.status)}</span>
            <Money cents={detail.totalCents} className="ml-auto font-medium text-text" />
          </div>
          <PurchaseTrace key={detail.id} detail={detail} defaultOpen={focusStep(detail)} />
          {detail.reasons.length > 0 && (
            <section aria-labelledby="ledger-detail-why">
              <h3 id="ledger-detail-why" className="text-meta text-muted">
                Why it was not simply allowed
              </h3>
              <ul className="mt-1 grid list-disc gap-0.5 pl-4 text-body break-words text-text marker:text-muted">
                {detail.reasons.map((reason, index) => (
                  // Two reasons can read the same.
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </section>
          )}
          <WhatWouldChange change={detail.change} reasons={detail.reasons} />
        </>
      )}
    </SidePanel>
  );
}

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function LedgerGrid({ rows, labelledBy }: { rows: PurchaseDetail[]; labelledBy: string }) {
  const [open, setOpen] = useState<PurchaseDetail | null>(null);
  return (
    <>
      <SellerGrid rows={rows} columns={columns} label="purchases" labelledBy={labelledBy} onOpen={setOpen} />
      <DetailPanel detail={open} onClose={() => setOpen(null)} />
    </>
  );
}
