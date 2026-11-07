import type { ReactNode } from 'react';
import { consoleTime } from '@/lib/ui/format';

// The agent run as a console, not chat bubbles: one row per event, with its UTC time, its kind and
// its body. Tool calls and times are machine values, in mono; the agent's status lines and summary
// are plain language, in sans. A row can carry detail under its body, such as a proposal's
// authority trace. Purely presentational: the shop page feeds it rows as the run streams.
//
// The rows share one grid, so times, kinds and bodies line up down the console; each row is its own
// list item on a subgrid. On a phone the kind sits above the body.

export type ConsoleKind = 'tool' | 'status' | 'proposal' | 'summary' | 'error';

export type ConsoleRow = {
  id: string;
  at: Date | string;
  kind: ConsoleKind;
  /** Shown in the kind column, such as the tool's name. Omit it for a plain line. */
  label?: string;
  body: ReactNode;
  /** Shown under the body, such as a proposal's authority trace. */
  detail?: ReactNode;
  /**
   * Puts the body under its kind, across the kind and body columns (and the whole width on a
   * phone), for a wide card such as a proposal.
   */
  wide?: boolean;
};

const BODY: Record<ConsoleKind, string> = {
  tool: 'font-mono text-meta text-muted',
  status: 'text-body text-muted',
  proposal: 'text-body text-text',
  summary: 'text-body text-text',
  error: 'text-body text-stop',
};

const LABEL: Record<ConsoleKind, string> = {
  tool: 'font-mono text-meta font-medium text-text',
  status: 'text-meta text-muted',
  proposal: 'text-meta font-medium text-text',
  summary: 'text-meta font-medium text-text',
  error: 'text-meta font-medium text-stop',
};

export function Console({
  rows,
  label,
  header,
  empty,
  live = false,
  className = '',
}: {
  rows: readonly ConsoleRow[];
  /** The console's accessible name, such as "Your agent's run". */
  label: string;
  /** Shown above the rows, such as the request and whether the run is still going. */
  header?: ReactNode;
  /** Shown when there are no rows yet. */
  empty?: ReactNode;
  /** Announces new rows to screen readers as they arrive. */
  live?: boolean;
  className?: string;
}) {
  return (
    <section aria-label={label} className={`min-w-0 overflow-hidden rounded-panel border border-line bg-panel ${className}`}>
      {header && <div className="border-b border-line px-4 py-2.5">{header}</div>}
      {rows.length === 0 && empty ? (
        <div className="px-4 py-6 text-body text-muted">{empty}</div>
      ) : (
        <ol
          aria-live={live ? 'polite' : undefined}
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 py-2 sm:grid-cols-[auto_auto_minmax(0,1fr)]"
        >
          {rows.map((row) => {
            const time = consoleTime(row.at);
            const iso = time === null ? undefined : typeof row.at === 'string' ? row.at : row.at.toISOString();
            return (
              <li
                key={row.id}
                className="col-span-full grid grid-cols-subgrid items-baseline gap-y-1 px-4 py-1.5 transition-colors hover:bg-raised/50"
              >
                <time dateTime={iso} title={iso} className="font-mono text-meta text-muted tabular-nums">
                  {time ?? '--:--:--'}
                </time>
                {row.label ? (
                  <span className={`col-start-2 min-w-0 break-words ${row.wide ? 'sm:col-span-2' : ''} ${LABEL[row.kind]}`}>{row.label}</span>
                ) : (
                  <span aria-hidden className="hidden sm:block" />
                )}
                <div
                  className={`col-start-2 min-w-0 break-words ${
                    row.wide ? 'col-span-full col-start-1 sm:col-span-2 sm:col-start-2' : 'sm:col-start-3 sm:row-start-1'
                  } ${BODY[row.kind]}`}
                >
                  {row.body}
                </div>
                {row.detail && (
                  <div className={`min-w-0 pt-1 ${row.wide ? 'col-span-full col-start-1 sm:col-span-2 sm:col-start-2' : 'col-start-2 sm:col-start-3'}`}>
                    {row.detail}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
