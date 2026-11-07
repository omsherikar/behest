import Link from 'next/link';

// The links between the buyer's pages, with the current one marked.

const PAGES = [
  { href: '/buyer', label: 'Mandate' },
  { href: '/buyer/shop', label: 'Shop' },
  { href: '/buyer/approvals', label: 'Approvals' },
  { href: '/buyer/ledger', label: 'Ledger' },
] as const;

export type BuyerPage = (typeof PAGES)[number]['href'];

export function BuyerNav({ current }: { current: BuyerPage }) {
  return (
    <nav aria-label="Buyer pages" className="flex flex-wrap gap-2 text-sm">
      {PAGES.map(({ href, label }) => {
        const here = href === current;
        return (
          <Link
            key={href}
            href={href}
            aria-current={here ? 'page' : undefined}
            className={`rounded-full px-3 py-1.5 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue ${
              here ? 'bg-pp-highlight text-pp-blue-dark' : 'text-pp-blue hover:bg-pp-highlight'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
