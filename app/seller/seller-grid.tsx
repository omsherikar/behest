'use client';

// The AG Grid behind the seller's catalog and orders pages, the operator's disputes list and the
// buyer's ledger, styled like the app's other grids (app/(endpoints)/data-grid.tsx). Each page
// defines its columns in its own client component, so they can format values and render cells; the
// rows come from the server.

import { useCallback, useRef, useState } from 'react';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  enableDevValidations,
  NumberFilterModule,
  QuickFilterModule,
  RowApiModule,
  RowAutoHeightModule,
  TextFilterModule,
  colorSchemeDark,
  themeQuartz,
  type ColDef,
  type ColTypeDef,
  type GetRowIdParams,
  type GridApi,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { fieldClass } from '@/components/ui/field';
import { cn } from '@/lib/utils';

if (process.env.NODE_ENV !== 'production') {
  enableDevValidations();
}

// Only the grid features these pages use: in-memory rows, text and number filters, the search box
// (quick filter), sizing columns to their content and to the grid's width, cell classes
// (right-aligned amounts, SKUs) and rows as tall as their wrapped text (the ledger's reasons).
const modules = [
  ClientSideRowModelModule,
  TextFilterModule,
  NumberFilterModule,
  QuickFilterModule,
  ColumnAutoSizeModule,
  // Reads the columns' widths, to tell whether they fill the grid, and how many rows are shown.
  ColumnApiModule,
  RowApiModule,
  CellStyleModule,
  RowAutoHeightModule,
];

// The Behest tokens (app/globals.css) on AG Grid's dark colour scheme: panel rows with hairline
// dividers, a raised header and hover, the text colour for focus and selection, and the radii and
// control border of the app's own panels and fields.
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
  wrapperBorderRadius: 16,
  borderRadius: 12,
  menuBackgroundColor: 'var(--raised)',
  inputBackgroundColor: 'var(--bg)',
  inputBorder: { color: 'var(--control)' },
});

const defaultColDef: ColDef = { filter: true };

/**
 * `type: 'numeric'` for an amount or a count: right-aligned under a right-aligned header, in mono
 * with tabular figures, so a column of numbers lines up.
 */
const columnTypes: Record<string, ColTypeDef> = {
  numeric: { headerClass: 'ag-right-aligned-header', cellClass: ['ag-right-aligned-cell', 'font-mono', 'tabular-nums'] },
};

/**
 * Up to this many rows, the grid is as tall as its rows, so a short list leaves no empty band;
 * beyond it, the grid keeps a fixed height and scrolls.
 */
const MAX_ROWS_IN_FULL = 15;

/**
 * Sizes every column to its header and its cells, so nothing is cut short. When that leaves room on
 * the right, the columns marked `context: { fill: true }` (such as the ledger's reasons) take all of
 * it; without such a column every column widens in proportion. A grid narrower than its content
 * scrolls sideways instead of cutting a header.
 */
function fillColumns(api: GridApi, box: HTMLElement | null) {
  // The scrolling area the columns sit in (`ag-grid-viewport` in AG Grid 36, `ag-body-viewport` before).
  const room = box?.querySelector('.ag-grid-viewport, .ag-body-viewport')?.clientWidth ?? 0;
  const columns = api.getAllDisplayedColumns();
  const used = columns.reduce((sum, column) => sum + column.getActualWidth(), 0);
  if (room === 0 || used >= room) return;
  const fill = (column: (typeof columns)[number]) => (column.getColDef().context as { fill?: boolean } | undefined)?.fill === true;
  const anyFill = columns.some(fill);
  // AG Grid spreads the room from the columns' default widths, so each column's content width is
  // its floor: no column ends narrower than its content. With a fill column, the others stay put.
  api.sizeColumnsToFit({
    columnLimits: columns.map((column) => {
      const width = column.getActualWidth();
      return anyFill && !fill(column) ? { key: column.getColId(), minWidth: width, maxWidth: width } : { key: column.getColId(), minWidth: width };
    }),
  });
}

/** AG Grid sizes the columns to their content once the rows are drawn; filling waits for that. */
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
  /** How many rows the grid shows after the search, which decides its height. */
  const [shown, setShown] = useState(rows.length);
  const fitsRows = shown <= MAX_ROWS_IN_FULL;
  const box = useRef<HTMLDivElement>(null);
  /** Whether the columns have been sized to their content once. */
  const sized = useRef(false);
  // AG Grid has no option for the grid's accessible name. It sets role="grid" on one of its own
  // elements, so the name goes on whichever element carries that role once the grid is ready.
  const nameGrid = useCallback(() => {
    box.current?.querySelector('[role="grid"], [role="treegrid"]')?.setAttribute('aria-labelledby', labelledBy);
  }, [labelledBy]);

  return (
    <div className="grid gap-3">
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={`Search ${label}...`}
        aria-label={`Search ${label}`}
        className={cn(fieldClass, 'h-10 py-0 sm:w-80')}
      />
      <div ref={box} className={cn('quiet-grid-headers', !fitsRows && 'h-[40rem]', onOpen && '[&_.ag-row]:cursor-pointer')}>
        <AgGridProvider modules={modules}>
          <AgGridReact<Row>
            theme={theme}
            rowData={rows}
            columnDefs={columns}
            defaultColDef={defaultColDef}
            columnTypes={columnTypes}
            domLayout={fitsRows ? 'autoHeight' : 'normal'}
            onModelUpdated={(event) => setShown(event.api.getDisplayedRowCount())}
            getRowId={rowId<Row>}
            quickFilterText={search}
            enableCellTextSelection
            onGridReady={nameGrid}
            autoSizeStrategy={autoSizeStrategy}
            // A new width sizes the columns to their content again, which then fills the width again.
            // Before the first sizing, when no row is drawn yet, there is nothing to measure.
            onGridSizeChanged={(event) => {
              if (sized.current) event.api.autoSizeAllColumns();
            }}
            onColumnResized={(event) => {
              if (!event.finished || event.source !== 'autosizeColumns') return;
              sized.current = true;
              fillColumns(event.api, box.current);
            }}
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
