import { formatUsd } from '@/lib/domain/money';

// An amount of integer cents as dollars, in tabular figures so amounts line up in a column. In
// tables, `mono` sets it in Plex Mono like the other machine values there.

export function Money({
  cents,
  missing = 'Not priced',
  mono = false,
  className = '',
}: {
  cents: number | null;
  /** What to show when there is no amount. */
  missing?: string;
  mono?: boolean;
  className?: string;
}) {
  if (cents === null) return <span className={`text-muted ${className}`}>{missing}</span>;
  return (
    <data value={(cents / 100).toFixed(2)} className={`tabular-nums ${mono ? 'font-mono' : ''} ${className}`}>
      {formatUsd(cents)}
    </data>
  );
}
