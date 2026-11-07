'use client';

// The AG Grid behind the seller's catalog and orders pages, the operator's disputes list and the
// buyer's ledger, styled like the app's other grids (app/(endpoints)/data-grid.tsx). Each page
// defines its columns in its own client component, so they can format values and render cells; the
// rows come from the server.

import { useCallback, useRef, useState } from 'react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnAutoSizeModule,
  enableDevValidations,
  NumberFilterModule,
  QuickFilterModule,
  RowAutoHeightModule,
  TextFilterModule,
  colorSchemeDark,
  themeQuartz,
  type ColDef,
  type GetRowIdParams,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';

if (process.env.NODE_ENV !== 'production') {
  enableDevValidations();
}

// Only the grid features these pages use: in-memory rows, text and number filters, the search box
// (quick filter), sizing columns to their content, cell classes (right-aligned amounts, SKUs) and
// rows as tall as their wrapped text (the ledger's reasons).
const modules = [
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ColumnAutoSizeModule,
  CellStyleModule,
  RowAutoHeightModule,
];

// The Behest tokens (app/globals.css) on AG Grid's dark colour scheme: panel rows with hairline
// dividers, a raised header and hover, and the action colour for focus and selection.
const theme = themeQuartz.withPart(colorSchemeDark).withParams({
  fontFamily: 'var(--font-sans-stack)',
  fontSize: 13,
  backgroundColor: 'var(--panel)',
  foregroundColor: 'var(--text)',
  cellTextColor: 'var(--text)',
  accentColor: 'var(--action)',
  borderColor: 'var(--line)',
  chromeBackgroundColor: 'var(--raised)',
  headerBackgroundColor: 'var(--raised)',
  headerTextColor: 'var(--muted)',
  headerFontWeight: 500,
  headerCellHoverBackgroundColor: 'var(--raised)',
  rowHoverColor: 'var(--raised)',
  oddRowBackgroundColor: 'var(--panel)',
  selectedRowBackgroundColor: 'color-mix(in srgb, var(--action) 14%, transparent)',
  rowBorder: { color: 'var(--line)' },
  columnBorder: false,
  headerColumnBorder: false,
  wrapperBorderRadius: 8,
  borderRadius: 4,
  menuBackgroundColor: 'var(--raised)',
  inputBackgroundColor: 'var(--bg)',
  inputBorder: { color: 'var(--line-strong)' },
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
  labelledBy,
  onOpen,
}: {
  rows: Row[];
  columns: ColDef<Row>[];
  /** What the rows are, for the search box's label, such as "listings". */
  label: string;
  /** The id of the element that names the grid, such as the page heading. */
  labelledBy: string;
  /** Opens a row, such as its detail: called on a click on the row or Enter on one of its cells. */
  onOpen?: (row: Row) => void;
}) {
  const [search, setSearch] = useState('');
  const box = useRef<HTMLDivElement>(null);
  // AG Grid has no option for the grid's accessible name. It sets role="grid" on one of its own
  // elements, so the name goes on whichever element carries that role once the grid is ready.
  const nameGrid = useCallback(() => {
    box.current?.querySelector('[role="grid"], [role="treegrid"]')?.setAttribute('aria-labelledby', labelledBy);
  }, [labelledBy]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={`Search ${label}...`}
        aria-label={`Search ${label}`}
        className="h-9 w-full rounded-control border border-line-strong bg-panel px-3 text-body text-text placeholder:text-muted sm:w-72"
      />
      <div ref={box} className={`min-h-72 flex-1 ${onOpen ? '[&_.ag-row]:cursor-pointer' : ''}`}>
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
            onGridReady={nameGrid}
            onRowClicked={onOpen ? (event) => event.data && onOpen(event.data) : undefined}
            onCellKeyDown={
              onOpen
                ? (event) => {
                    if (event.event instanceof KeyboardEvent && event.event.key === 'Enter' && event.data) onOpen(event.data);
                  }
                : undefined
            }
          />
        </AgGridProvider>
      </div>
    </div>
  );
}
