'use client';

import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUsd } from '@/lib/domain/money';
import type { DisputeRow } from '@/lib/ops-pages/disputes';
import { SellerGrid } from '@/app/seller/seller-grid';

// Every dispute buyers opened at PayPal, latest first. The dispute id links to its page, and comes
// first so the link is in view on a phone too; a click on the row, or Enter on it, opens it as well.
// Reasons and statuses are PayPal's, as plain text.

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

function DisputeLinkCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  return (
    <Link
      href={`/ops/disputes/${data.id}`}
      className="font-mono font-medium text-action underline-offset-2 hover:text-action-strong hover:underline"
    >
      {data.paypalDisputeId}
    </Link>
  );
}

function MatchedCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  return data.linked ? (
    <StatusBadge tone="seal" label="Purchase">
      Matched
    </StatusBadge>
  ) : (
    <StatusBadge tone="muted" label="Purchase">
      Not matched
    </StatusBadge>
  );
}

function EvidenceCell({ data }: CustomCellRendererProps<DisputeRow>) {
  if (!data) return null;
  return data.submitted ? (
    <StatusBadge tone="seal" label="Evidence">
      Answered
    </StatusBadge>
  ) : (
    <StatusBadge tone="hold" label="Evidence">
      Not answered
    </StatusBadge>
  );
}

const columns: ColDef<DisputeRow>[] = [
  { field: 'paypalDisputeId', headerName: 'PayPal dispute', cellRenderer: DisputeLinkCell },
  {
    field: 'openedAt',
    headerName: 'Opened (UTC)',
    sort: 'desc',
    cellClass: 'font-mono',
    valueFormatter: ({ value }: ValueFormatterParams<DisputeRow, string | null>) => opened(value),
    getQuickFilterText: ({ value }) => opened(value),
  },
  { field: 'reason', headerName: 'Reason' },
  { field: 'status', headerName: 'Status' },
  {
    field: 'amountCents',
    headerName: 'Amount',
    type: 'numeric',
    valueFormatter: ({ value }: ValueFormatterParams<DisputeRow, number>) => (typeof value === 'number' ? formatUsd(value) : ''),
    filter: 'agNumberColumnFilter',
    filterValueGetter: ({ data }) => (typeof data?.amountCents === 'number' ? data.amountCents / 100 : null),
  },
  {
    colId: 'linked',
    headerName: 'Purchase',
    valueGetter: ({ data }) => (data?.linked ? 'Matched' : 'Not matched'),
    cellRenderer: MatchedCell,
  },
  {
    colId: 'submitted',
    headerName: 'Evidence',
    valueGetter: ({ data }) => (data?.submitted ? 'Answered' : 'Not answered'),
    cellRenderer: EvidenceCell,
  },
];

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function DisputesGrid({ rows, labelledBy }: { rows: DisputeRow[]; labelledBy: string }) {
  const router = useRouter();
  return (
    <SellerGrid
      rows={rows}
      columns={columns}
      label="disputes"
      labelledBy={labelledBy}
      onOpen={(row) => router.push(`/ops/disputes/${row.id}`)}
    />
  );
}
