'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { formatUsd } from '@/lib/domain/money';
import type { SellerOrderRow } from '@/lib/seller-pages/orders';
import { SellerGrid } from '../seller-grid';

// The seller's agent orders, newest first: whether the receipt presented with each one checked out,
// why not when it did not, the cart total and, for an accepted order, the payout.

// 6 Nov 2026, 11:20 UTC
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

function ReceiptCheckCell({ data }: CustomCellRendererProps<SellerOrderRow>) {
  if (!data) return null;
  const accepted = data.status === 'accepted';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs leading-5 font-semibold text-white ${accepted ? 'bg-pp-success' : 'bg-pp-danger'}`}
    >
      {accepted ? 'Accepted' : 'Rejected'}
    </span>
  );
}

const columns: ColDef<SellerOrderRow>[] = [
  {
    field: 'createdAt',
    headerName: 'Time (UTC)',
    sort: 'desc',
    valueFormatter: ({ value }: ValueFormatterParams<SellerOrderRow, string>) =>
      value ? `${dateTime.format(new Date(value))} UTC` : '',
    getQuickFilterText: ({ value }) => (value ? dateTime.format(new Date(value)) : ''),
  },
  {
    field: 'status',
    headerName: 'Receipt check',
    valueGetter: ({ data }) => (data?.status === 'accepted' ? 'Accepted' : 'Rejected'),
    cellRenderer: ReceiptCheckCell,
  },
  { field: 'reason', headerName: 'Why rejected', valueFormatter: ({ value }) => value ?? '' },
  {
    field: 'totalCents',
    headerName: 'Cart total',
    type: 'rightAligned',
    valueFormatter: ({ value }: ValueFormatterParams<SellerOrderRow, number | null>) =>
      typeof value === 'number' ? formatUsd(value) : '',
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.totalCents === 'number' ? data.totalCents / 100 : null),
  },
  { field: 'payout', headerName: 'Payout', valueFormatter: ({ value }) => value ?? '' },
  {
    field: 'receiptId',
    headerName: 'Receipt id',
    cellClass: 'font-mono',
    valueFormatter: ({ value }) => value ?? 'None readable',
  },
];

export function OrdersGrid({ rows }: { rows: SellerOrderRow[] }) {
  return <SellerGrid rows={rows} columns={columns} label="orders" />;
}
