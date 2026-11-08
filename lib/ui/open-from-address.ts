// A grid's side panel can be opened from the address, as `?open=<id>`, so a link can show one
// record: the guided demo uses it to open a pinned purchase or order. The panel drops the parameter
// again when it closes, so a reload shows the plain page.

/** The query parameter naming the record whose panel to open. */
export const OPEN_PARAM = 'open';

/** The row the address names, or null when it names none of them. */
export function rowToOpen<Row extends { id: string }>(rows: readonly Row[], open: string | null): Row | null {
  if (!open) return null;
  return rows.find((row) => row.id === open) ?? null;
}

/** The query string with `open` removed: '' when nothing is left, otherwise starting with '?'. */
export function withoutOpen(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(OPEN_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}
