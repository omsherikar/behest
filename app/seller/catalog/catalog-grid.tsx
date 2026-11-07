'use client';

import type { ColDef, ValueFormatterParams, ValueGetterParams } from 'ag-grid-community';
import type { CustomCellRendererProps } from 'ag-grid-react';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatUsd } from '@/lib/domain/money';
import { benchmark } from '@/lib/seller-pages/benchmark';
import type { CatalogRow } from '@/lib/seller-pages/catalog';
import { SellerGrid } from '../seller-grid';

// The seller's listings. Each one says whether agents can buy it: listed, or hidden from agents
// with the reason screening gave, in the column next to its SKU so it is in view on a phone too. Its
// price sits beside its market benchmark: the median of the same product elsewhere and how far the
// seller's price is from it, marked when it is far enough above that the buyer is asked first.

/** Price filters take dollars, as the column shows them, rather than the cents behind it. */
const dollars =
  (field: 'priceCents' | 'marketMedianCents') =>
  ({ data }: ValueGetterParams<CatalogRow>) => {
    const cents = data?.[field];
    return typeof cents === 'number' ? cents / 100 : null;
  };

function AgentsCell({ data }: CustomCellRendererProps<CatalogRow>) {
  if (!data) return null;
  if (data.hiddenReason === null) {
    return (
      <StatusBadge tone="seal" label="For agents">
        Listed
      </StatusBadge>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1 py-2 leading-snug whitespace-normal">
      <StatusBadge tone="stop" label="For agents">
        Hidden from agents
      </StatusBadge>
      <span className="text-stop">{data.hiddenReason}</span>
    </span>
  );
}

function PriceCell({ data }: CustomCellRendererProps<CatalogRow>) {
  if (!data) return null;
  const mark = benchmark(data.priceCents, data.marketMedianCents);
  return (
    <span className="flex flex-col items-end py-2 leading-snug whitespace-normal">
      <span className="font-mono text-text">{formatUsd(data.priceCents)}</span>
      {mark ? (
        <span className={mark.asks ? 'text-hold' : 'text-muted'}>
          {mark.words}
          {mark.asks && <span className="block">Buyers are asked first</span>}
        </span>
      ) : (
        <span className="text-muted">No market benchmark</span>
      )}
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
    autoHeight: true,
  },
  { field: 'title', headerName: 'Title', maxWidth: 360 },
  { field: 'category', headerName: 'Category' },
  {
    field: 'priceCents',
    headerName: 'Price and market median',
    type: 'rightAligned',
    cellRenderer: PriceCell,
    autoHeight: true,
    getQuickFilterText: ({ data }) => (data ? `${formatUsd(data.priceCents)} ${benchmark(data.priceCents, data.marketMedianCents)?.words ?? ''}` : ''),
    filter: 'agNumberColumnFilter',
    filterValueGetter: dollars('priceCents'),
  },
  {
    field: 'stock',
    headerName: 'Stock',
    type: 'numeric',
    valueFormatter: ({ value }: ValueFormatterParams<CatalogRow, number | null>) =>
      value === null || value === undefined ? 'Not counted' : String(value),
    filter: 'agNumberColumnFilter',
  },
];

/** `labelledBy` is the id of the element that names the grid, such as the page heading. */
export function CatalogGrid({ rows, labelledBy }: { rows: CatalogRow[]; labelledBy: string }) {
  return <SellerGrid rows={rows} columns={columns} label="listings" labelledBy={labelledBy} />;
}
