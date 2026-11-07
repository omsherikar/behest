// Reading a seller's catalog CSV into rows for the catalog builder. Sellers export from spreadsheets, so
// the reader forgives what spreadsheets do (a byte order mark, Windows line endings, `$4.50` or `4,50`,
// blank rows, semicolons between fields, column names like `title` or `qty`) and rejects anything it
// cannot read with certainty, giving the line in the seller's file and a reason the seller can act on.
// Names and descriptions are seller text that buyers see and models read, so they are cleaned and capped.

import Papa from 'papaparse';
import { removeHiddenCharacters } from '@/lib/llm/untrusted';

export type CatalogRow = {
  /** The line in the seller's file where the row starts, counting the header as line 1. */
  line: number;
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  /** Units on hand, or null when the file does not say. */
  stock: number | null;
  /** The category as the seller wrote it. The catalog builder maps it onto the fixed list. */
  category: string | null;
};

export type CatalogRejection = { line: number; reason: string };

/** Data rows after this many are rejected. */
export const ROW_LIMIT = 200;

/**
 * The largest CSV a seller may send, in UTF-8 bytes. `ROW_LIMIT` rows of plain text at the longest
 * name and description the reader keeps come to about 0.4 MB, so a real catalog fits with room to spare.
 */
export const CSV_MAX_BYTES = 1024 * 1024;

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const SKU_MAX = 64;
/** The longest price cell read, far more than `USD 21,474,836.47` needs. */
const PRICE_CELL_MAX = 32;
/** What a SKU may be: letters, digits, dot, dash and underscore, starting with a letter or digit, at most 64 characters. */
export const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The largest value of a Postgres integer, the column type of price and stock. */
const INT_MAX = 2_147_483_647;

/** Header names for each field, matched trimmed and case-insensitively. When a file has several, the earlier name wins. */
const ALIASES = {
  sku: ['sku', 'id', 'code'],
  name: ['name', 'title', 'product'],
  description: ['description', 'desc', 'details'],
  price: ['price', 'cost', 'amount'],
  stock: ['stock', 'qty', 'quantity', 'inventory'],
  category: ['category', 'type'],
} as const;

type Field = keyof typeof ALIASES;
type Columns = Record<Field, number | undefined>;

const REQUIRED: Field[] = ['name', 'price'];

type CsvRecord = { line: number; cells: string[]; unbalancedQuotes: boolean };

/**
 * The listings in a seller's CSV, and the rows that cannot be listings with the line each starts on and
 * why. Only the first `ROW_LIMIT` data rows are read; the rows after them are reported as one rejection,
 * at the first of them, saying how many were left out. The first row to use a SKU keeps it, even when
 * that row is rejected for another reason, so a later row with the same SKU is reported as a duplicate.
 */
export function parseCatalogCsv(text: string): { rows: CatalogRow[]; rejected: CatalogRejection[] } {
  const { records: [header, ...records], leftOut } = readRecords(text, ROW_LIMIT + 1);
  if (header === undefined) return { rows: [], rejected: [{ line: 1, reason: 'the file is empty' }] };

  const columns = findColumns(header.cells);
  const missing = REQUIRED.filter((field) => columns[field] === undefined);
  if (missing.length > 0) {
    return { rows: [], rejected: missing.map((field) => ({ line: header.line, reason: `no ${field} column (${aliasList(field)})` })) };
  }

  const rows: CatalogRow[] = [];
  const rejected: CatalogRejection[] = [];
  const claimed = new Set<string>();
  for (const record of records) {
    const result = readRow(record, header.cells.length, columns, claimed);
    if (typeof result === 'string') rejected.push({ line: record.line, reason: result });
    else rows.push(result);
  }
  if (leftOut) {
    const rowsLeftOut = leftOut.count === 1 ? '1 row from this line on was' : `${leftOut.count} rows from this line on were`;
    rejected.push({ line: leftOut.line, reason: `row limit is ${ROW_LIMIT}: ${rowsLeftOut} left out` });
  }
  return { rows, rejected };
}

/** One data row as a listing, or the reason it cannot be one. */
function readRow(record: CsvRecord, width: number, columns: Columns, claimed: Set<string>): CatalogRow | string {
  const { cells } = record;
  if (record.unbalancedQuotes) return 'this row has unbalanced quotes';
  // A row that does not line up with the header, such as one with an unquoted `4,50`, would shift values
  // into the wrong columns and could list a wrong price, so it is rejected rather than guessed at. The
  // count must match exactly: a shift whose last field is blank leaves an extra field that is blank too.
  if (cells.length !== width) {
    return `row has ${cells.length} fields but the header has ${width}`;
  }
  const cell = (field: Field): string => {
    const index = columns[field];
    return index === undefined ? '' : cells[index];
  };

  const name = oneLine(cell('name'), NAME_MAX);
  if (name === '') return 'name is required';

  const givenSku = cell('sku').trim();
  const sku = givenSku === '' ? skuFromName(name) : givenSku;
  if (sku === '') return 'SKU is blank and none can be made from the name';
  if (!SKU_PATTERN.test(sku)) return 'SKU must be letters, digits, dot, dash or underscore';
  const key = sku.toUpperCase();
  if (claimed.has(key)) return `duplicate SKU ${sku}`;
  claimed.add(key);

  const priceCents = parsePriceCents(cell('price'));
  if (priceCents === null || priceCents <= 0) return 'price must be a positive amount';
  if (priceCents > INT_MAX) return 'price is too large';

  const stockText = cell('stock').trim();
  let stock: number | null = null;
  if (stockText !== '') {
    if (!/^\d+$/.test(stockText)) return 'stock must be a whole number';
    stock = Number(stockText);
    if (stock > INT_MAX) return 'stock is too large';
  }

  const category = oneLine(cell('category'), NAME_MAX);
  return {
    line: record.line,
    sku,
    name,
    description: multiLine(cell('description'), DESCRIPTION_MAX),
    priceCents,
    stock,
    category: category === '' ? null : category,
  };
}

/**
 * The first `limit` records in the file that have a non-blank cell, with the line each starts on,
 * and how many such records come after them, from which line. Records past the limit are only
 * counted, so a long file costs no more memory than a short one.
 */
function readRecords(text: string, limit: number): { records: CsvRecord[]; leftOut: { line: number; count: number } | null } {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const records: CsvRecord[] = [];
  let leftOut: { line: number; count: number } | null = null;
  let start = 0;
  let line = 1;
  Papa.parse<string[]>(source, {
    delimiter: delimiterOf(source),
    newline: '\n',
    step: ({ data, errors, meta }) => {
      if (data.some((cell) => cell.trim() !== '')) {
        if (records.length < limit) {
          records.push({ line, cells: data, unbalancedQuotes: errors.some((error) => error.type === 'Quotes') });
        } else {
          leftOut ??= { line, count: 0 };
          leftOut.count += 1;
        }
      }
      // The record ends where the next one starts, so the line breaks it spans, including any inside
      // quoted fields, move the line count on to the next record.
      line += lineBreaks(source, start, meta.cursor);
      start = meta.cursor;
    },
  });
  return { records, leftOut };
}

/** Spreadsheets in some locales put `;` or tabs between fields. The header line shows which a file uses. */
function delimiterOf(source: string): string {
  const header = source.trimStart().split('\n', 1)[0] ?? '';
  const count = (delimiter: string) => header.split(delimiter).length - 1;
  let best = ',';
  for (const candidate of [';', '\t']) if (count(candidate) > count(best)) best = candidate;
  return best;
}

function lineBreaks(text: string, from: number, to: number): number {
  let count = 0;
  for (let at = text.indexOf('\n', from); at !== -1 && at < to; at = text.indexOf('\n', at + 1)) count += 1;
  return count;
}

function findColumns(header: string[]): Columns {
  const names = header.map((cell) => cell.trim().toLowerCase());
  const column = (field: Field) => ALIASES[field].map((alias) => names.indexOf(alias)).find((index) => index !== -1);
  return {
    sku: column('sku'),
    name: column('name'),
    description: column('description'),
    price: column('price'),
    stock: column('stock'),
    category: column('category'),
  };
}

/** `name, title or product`. */
function aliasList(field: Field): string {
  const aliases = ALIASES[field];
  return `${aliases.slice(0, -1).join(', ')} or ${aliases[aliases.length - 1]}`;
}

/**
 * Cents from a price cell, or null when the cell is not a plain amount in dollars. Accepts `4.50`, `4.5`,
 * `4,50`, `$4.50`, `USD 4.50`, `4.50 USD` and `1,234.50`. A comma followed by three digits and no decimal
 * part, as in `1,234`, could be a thousands separator or a mistyped decimal, so it is not accepted, and
 * neither is a dot used as a thousands separator, as in `1.234,50`. A cell longer than `PRICE_CELL_MAX`
 * once trimmed is no price, so it is rejected before any pattern runs on it.
 */
function parsePriceCents(cell: string): number | null {
  const text = cell.trim();
  if (text.length > PRICE_CELL_MAX) return null;
  // No two adjacent parts of this pattern can match the same characters, so it runs in linear time.
  const amount = /^(?:usd)?\s*(?:\$\s*)?([\d.,]+)\s*(?:usd)?$/i.exec(text)?.[1];
  if (amount === undefined) return null;
  const parts = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(amount) ?? /^(\d{1,3}(?:,\d{3})+)\.(\d{1,2})$/.exec(amount);
  if (parts === null) return null;
  return Number(parts[1].replaceAll(',', '')) * 100 + Number((parts[2] ?? '').padEnd(2, '0'));
}

/** A SKU for a row that has none: the name as a slug in capitals, such as `TURMERIC-POWDER-100G`. */
function skuFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SKU_MAX)
    .replace(/-+$/, '')
    .toUpperCase();
}

/** Seller text on one line: hidden characters dropped, runs of whitespace made one space, at most `max` code points. */
export function oneLine(text: string, max: number): string {
  return firstCodePoints(removeHiddenCharacters(text).replace(/\s+/g, ' ').trim(), max);
}

/** Seller text that keeps its line breaks and tabs: hidden characters dropped, at most `max` code points. */
export function multiLine(text: string, max: number): string {
  return firstCodePoints(removeHiddenCharacters(text).trim(), max);
}

/** The first `max` code points of well-formed `text`, so a cut never splits a surrogate pair. */
export function firstCodePoints(text: string, max: number): string {
  let end = 0;
  for (let count = 0; count < max && end < text.length; count += 1) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return end === text.length ? text : text.slice(0, end).trimEnd();
}
