import Link from 'next/link';
import { buttonClass } from './button';

// What a page or a panel shows when it has nothing yet, centred in the space it would fill: one
// sentence on why, and the one thing to do about it, such as an empty ledger linking to the shop.

export function EmptyState({
  message,
  action,
  className = '',
}: {
  message: string;
  action?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center rounded-frame border border-dashed border-line-strong px-6 py-14 text-center ${className}`}
    >
      <p className="max-w-[48ch] text-body text-pretty text-muted">{message}</p>
      {action && (
        <Link href={action.href} className={buttonClass('primary', 'default', 'mt-6')}>
          {action.label}
        </Link>
      )}
    </div>
  );
}
