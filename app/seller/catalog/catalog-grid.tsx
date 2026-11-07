'use client';

import type { ColDef, ValueFormatterParams, ValueGetterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { formatUsd } from '@/lib/domain/money';
import type { CatalogRow } from '@/lib/seller-pages/catalog';
import { SellerGrid } from '../seller-grid';

// The seller's listings. A listing hidden from agents is marked in the column next to its SKU, so
// the mark is in view on a phone too, with the reason it is hidden.

const usd = ({ value }: ValueFormatterParams<CatalogRow, number | null>) => (typeof value === 'number' ? formatUsd(value) : '');

/** Price filters take dollars, as the column shows them, rather than the cents behind it. */
const dollars =
  (field: 'priceCents' | 'marketMedianCents') =>
  ({ data }: ValueGetterParams<CatalogRow>) => {
    const cents = data?.[field];
    return typeof cents === 'number' ? cents / 100 : null;
  };

function AgentsCell({ data }: CustomCellRendererProps<CatalogRow>) {
  if (!data) return null;
  if (data.hiddenReason === null) return <span className="text-pp-success">Listed</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="rounded-full bg-pp-danger px-2 py-0.5 text-xs leading-5 font-semibold text-on-fill">
        Hidden from agents
      </span>
      <span className="text-pp-danger">{data.hiddenReason}</span>
    </span>
  );
}

const columns: ColDef<CatalogRow>[] = [
  { field: 'sku', headerName: 'SKU', cellClass: 'font-mono' },
  {
    colId: 'agents',
    headerName: 'For agents',
    valueGetter: ({ data }) => (data?.hiddenReason ? `Hidden from agents: ${data.hiddenReason}` : 'Listed'),
    cellRenderer: AgentsCell,
  },
  { field: 'title', headerName: 'Title', maxWidth: 360 },
  { field: 'category', headerName: 'Category' },
  {
    field: 'priceCents',
    headerName: 'Price',
    type: 'rightAligned',
    valueFormatter: usd,
    filter: 'agNumberColumnFilter',
    filterValueGetter: dollars('priceCents'),
  },
  {
    field: 'stock',
    headerName: 'Stock',
    type: 'rightAligned',
    valueFormatter: ({ value }: ValueFormatterParams<CatalogRow, number | null>) =>
      value === null || value === undefined ? 'Not counted' : String(value),
    filter: 'agNumberColumnFilter',
  },
  {
    field: 'marketMedianCents',
    headerName: 'Market median',
    type: 'rightAligned',
    valueFormatter: (params: ValueFormatterParams<CatalogRow, number | null>) =>
      typeof params.value === 'number' ? usd(params) : 'No benchmark',
    filter: 'agNumberColumnFilter',
    filterValueGetter: dollars('marketMedianCents'),
  },
];

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function CatalogGrid({ rows, labelledBy }: { rows: CatalogRow[]; labelledBy: string }) {
  return <SellerGrid rows={rows} columns={columns} label="listings" labelledBy={labelledBy} />;
}
