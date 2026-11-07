'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import type { LedgerRow } from '@/lib/buyer-pages/purchases';
import { statusWords } from '@/lib/buyer-pages/words';
import { formatUsd } from '@/lib/domain/money';
import { SellerGrid } from '@/app/seller/seller-grid';
import { VerdictChip } from '../verdict-chip';

// Every purchase the buyer's agent proposed, newest first: Behest's verdict, where the purchase
// stands in plain words, why it was not simply allowed and the id of its signed receipt. Seller
// names and reasons may be a seller's text, so every cell is rendered as text.

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

function VerdictCell({ data }: CustomCellRendererProps<LedgerRow>) {
  return data ? <VerdictChip verdict={data.verdict} /> : null;
}

function ReasonsCell({ data }: CustomCellRendererProps<LedgerRow>) {
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

const columns: ColDef<LedgerRow>[] = [
  {
    field: 'createdAt',
    headerName: 'Time (UTC)',
    sort: 'desc',
    valueFormatter: ({ value }: ValueFormatterParams<LedgerRow, string>) => (value ? dateTime.format(new Date(value)) : ''),
    getQuickFilterText: ({ value }) => (value ? dateTime.format(new Date(value)) : ''),
  },
  { field: 'seller', headerName: 'Seller' },
  {
    field: 'totalCents',
    headerName: 'Total',
    type: 'rightAligned',
    valueFormatter: ({ value }: ValueFormatterParams<LedgerRow, number | null>) =>
      typeof value === 'number' ? formatUsd(value) : 'Not priced',
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.totalCents === 'number' ? data.totalCents / 100 : null),
  },
  { field: 'verdict', headerName: 'Verdict', cellRenderer: VerdictCell },
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
    field: 'receiptId',
    headerName: 'Receipt id',
    cellClass: 'font-mono',
    valueFormatter: ({ value }: ValueFormatterParams<LedgerRow, string | null>) => value ?? 'None',
  },
];

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function LedgerGrid({ rows, labelledBy }: { rows: LedgerRow[]; labelledBy: string }) {
  return <SellerGrid rows={rows} columns={columns} label="purchases" labelledBy={labelledBy} />;
}
