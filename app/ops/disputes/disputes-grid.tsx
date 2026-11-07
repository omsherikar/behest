'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import Link from 'next/link';
import { formatUsd } from '@/lib/domain/money';
import type { DisputeRow } from '@/lib/ops-pages/disputes';
import { SellerGrid } from '@/app/seller/seller-grid';

// Every dispute buyers opened at PayPal, latest first. The dispute id links to its page, and comes
// first so the link is in view on a phone too. Reasons and statuses are PayPal's, as plain text.

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

const opened = (value: string | null | undefined) => (value ? dateTime.format(new Date(value)) : 'Not recorded');
const yesNo = (value: boolean | undefined) => (value ? 'Yes' : 'No');

function DisputeLinkCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  return (
    <Link
      href={`/ops/disputes/${data.id}`}
      className="font-mono font-semibold text-pp-blue hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue"
    >
      {data.paypalDisputeId}
    </Link>
  );
}

const columns: ColDef<DisputeRow>[] = [
  { field: 'paypalDisputeId', headerName: 'PayPal dispute', cellRenderer: DisputeLinkCell },
  {
    field: 'openedAt',
    headerName: 'Opened (UTC)',
    sort: 'desc',
    valueFormatter: ({ value }: ValueFormatterParams<DisputeRow, string | null>) => opened(value),
    getQuickFilterText: ({ value }) => opened(value),
  },
  { field: 'reason', headerName: 'Reason' },
  { field: 'status', headerName: 'Status' },
  {
    field: 'amountCents',
    headerName: 'Amount',
    type: 'rightAligned',
    valueFormatter: ({ value }: ValueFormatterParams<DisputeRow, number>) => (typeof value === 'number' ? formatUsd(value) : ''),
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.amountCents === 'number' ? data.amountCents / 100 : null),
  },
  { colId: 'linked', headerName: 'Matched to a purchase', valueGetter: ({ data }) => yesNo(data?.linked) },
  { colId: 'submitted', headerName: 'Evidence submitted', valueGetter: ({ data }) => yesNo(data?.submitted) },
];

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function DisputesGrid({ rows, labelledBy }: { rows: DisputeRow[]; labelledBy: string }) {
  return <SellerGrid rows={rows} columns={columns} label="disputes" labelledBy={labelledBy} />;
}
