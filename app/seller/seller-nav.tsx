import Link from 'next/link';

// The links between the seller's pages, with the current one marked.

const PAGES = [
  { href: '/seller', label: 'Shop' },
  { href: '/seller/catalog', label: 'Catalog' },
  { href: '/seller/orders', label: 'Orders' },
] as const;

export type SellerPage = (typeof PAGES)[number]['href'];

export function SellerNav({ current }: { current: SellerPage }) {
  return (
    <nav aria-label="Seller pages" className="flex flex-wrap gap-2 text-sm">
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
