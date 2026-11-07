import Link from 'next/link';
import { buttonClass } from './button';

// What a page shows when it has nothing yet: one sentence on why, and the one thing to do about
// it, such as an empty ledger linking to the shop.

export function EmptyState({ message, action }: { message: string; action: { href: string; label: string } }) {
  return (
    <div className="rounded-panel border border-dashed border-line-strong/60 px-5 py-8">
      <p className="max-w-[60ch] text-body text-muted">{message}</p>
      <Link href={action.href} className={buttonClass('secondary', 'default', 'mt-4')}>
        {action.label}
      </Link>
    </div>
  );
}
