'use client';

// The AG Grid behind the seller's catalog and orders pages, styled like the app's other grids
// (app/(endpoints)/data-grid.tsx). Each page defines its columns in its own client component, so
// they can format values and render cells; the rows come from the server.

import { useState } from 'react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  enableDevValidations,
  NumberFilterModule,
  QuickFilterModule,
  TextFilterModule,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';

if (process.env.NODE_ENV !== 'production') {
  enableDevValidations();
}

// Only the grid features these pages use: in-memory rows, text and number filters, the search box
// (quick filter), sizing columns to their content and cell classes (right-aligned amounts, SKUs).
const modules = [
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ColumnAutoSizeModule,
  CellStyleModule,
];

// Same PayPal tokens as the dashboard (app/globals.css).
const theme = themeQuartz.withParams({
  fontFamily: 'var(--pp-font)',
  accentColor: 'var(--pp-blue)',
  foregroundColor: 'var(--pp-ink)',
  borderColor: 'var(--pp-border)',
  headerFontWeight: 600,
  headerTextColor: 'var(--pp-muted)',
  rowHoverColor: 'var(--pp-highlight)',
});

const defaultColDef: ColDef = { filter: true };
const autoSizeStrategy = { type: 'fitCellContents' } as const;
/** Rows keep their database id as the grid's row id. One function for every render: AG Grid reads it once. */
function rowId<Row extends { id: string }>({ data }: GetRowIdParams<Row>): string {
  return data.id;
}

export function SellerGrid<Row extends { id: string }>({
  rows,
  columns,
  label,
}: {
  rows: Row[];
  columns: ColDef<Row>[];
  /** What the rows are, for the search box's label, such as "listings". */
  label: string;
}) {
  const [search, setSearch] = useState('');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={`Search ${label}...`}
        aria-label={`Search ${label}`}
        className="h-10 w-full rounded border border-pp-border bg-pp-surface px-3 text-sm outline-none focus:border-pp-blue sm:w-72"
      />
      <div className="min-h-72 flex-1">
        <AgGridProvider modules={modules}>
          <AgGridReact<Row>
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            getRowId={rowId<Row>}
            quickFilterText={search}
            autoSizeStrategy={autoSizeStrategy}
            enableCellTextSelection
          />
        </AgGridProvider>
      </div>
    </div>
  );
}
