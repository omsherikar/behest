'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { reasonsHeading, statusWords } from '@/lib/buyer-pages/words';
import { formatUsd } from '@/lib/domain/money';
import { shortId } from '@/lib/ui/format';
import { SellerGrid } from '@/app/seller/seller-grid';
import { focusStep, PurchaseTrace } from '@/components/purchase/purchase-trace';
import { MiniTrace } from '@/components/ui/mini-trace';
import { Money } from '@/components/ui/money';
import { SidePanel } from '@/components/ui/side-panel';
import { useOpenFromAddress } from '@/components/ui/use-open-from-address';
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

/** The verdict, with the authority trace in small under it: both say how the purchase was decided. */
function VerdictCell({ data }: CustomCellRendererProps<PurchaseDetail>) {
  if (!data) return null;
  // The grid's own styles set the cell's line height to the row height, so the cell sets its own.
  return (
    <div className="flex flex-col items-start gap-1.5 py-2.5 leading-normal">
      <VerdictBadge verdict={data.verdict} />
      <MiniTrace states={data.trace} />
    </div>
  );
}

function StatusCell({ value }: CustomCellRendererProps<PurchaseDetail, string>) {
  // Its own line height, as the reasons set theirs, so a wrapped status reads as one block.
  return <span className="block py-2.5 leading-snug">{value}</span>;
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
    type: 'numeric',
    valueFormatter: ({ value }: ValueFormatterParams<PurchaseDetail, number | null>) =>
      typeof value === 'number' ? formatUsd(value) : 'Not priced',
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.totalCents === 'number' ? data.totalCents / 100 : null),
  },
  // Wide enough for the longest verdict, "Needs your approval", with its glyph; the trace sits under it.
  { field: 'verdict', headerName: 'Verdict and trace', cellRenderer: VerdictCell, minWidth: 190, autoHeight: true },
  {
    colId: 'status',
    headerName: 'Status',
    valueGetter: ({ data }) => (data ? statusWords(data.status) : ''),
    // "Waiting for your approval" wraps rather than widening the column.
    width: 150,
    suppressAutoSize: true,
    wrapText: true,
    autoHeight: true,
    cellRenderer: StatusCell,
  },
  {
    colId: 'reasons',
    headerName: 'Reasons',
    valueGetter: ({ data }) => data?.reasons.join(' ') ?? '',
    cellRenderer: ReasonsCell,
    // Reasons can run long, so they wrap, and the column takes whatever width the others leave.
    width: 240,
    suppressAutoSize: true,
    context: { fill: true },
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

/** The side panel for one purchase: what it bought, its trace with the proof behind each step, why, and what would change. */
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
            <span className="text-body text-text">{statusWords(detail.status)}</span>
            <Money cents={detail.totalCents} className="ml-auto text-heading font-medium text-text" />
          </div>
          {detail.items.length > 0 && (
            <section aria-label="What it bought" className="rounded-panel border border-line">
              <ul className="divide-y divide-line">
                {detail.items.map((item) => (
                  <li key={item.sku} className="flex items-baseline justify-between gap-4 px-4 py-3 text-body">
                    <span className="min-w-0 break-words text-text">
                      {item.quantity} × {item.title} <span className="ml-1 font-mono text-meta text-muted">{item.sku}</span>
                    </span>
                    <Money cents={item.unitPriceCents * item.quantity} mono className="shrink-0 text-meta text-text" />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <PurchaseTrace key={detail.id} detail={detail} defaultOpen={focusStep(detail)} />
          {detail.reasons.length > 0 && (
            <section data-tour="purchase-reasons" aria-labelledby="ledger-detail-why">
              <h3 id="ledger-detail-why" className="text-meta text-muted">
                {reasonsHeading(detail.verdict)}
              </h3>
              <ul className="mt-1.5 grid gap-1">
                {detail.reasons.map((reason, index) => (
                  // Two reasons can read the same.
                  <li key={index} className="flex gap-2.5 text-body break-words text-text">
                    <span aria-hidden className="mt-2.5 size-1 shrink-0 rounded-full bg-muted" />
                    {reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div data-tour="what-would-change">
            <WhatWouldChange change={detail.change} reasons={detail.reasons} />
          </div>
        </>
      )}
    </SidePanel>
  );
}

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function LedgerGrid({ rows, labelledBy }: { rows: PurchaseDetail[]; labelledBy: string }) {
  const { open, setOpen, close } = useOpenFromAddress(rows);
  return (
    <>
      <div data-tour="ledger-grid">
        <SellerGrid rows={rows} columns={columns} label="purchases" labelledBy={labelledBy} onOpen={setOpen} />
      </div>
      <DetailPanel detail={open} onClose={close} />
    </>
  );
}
