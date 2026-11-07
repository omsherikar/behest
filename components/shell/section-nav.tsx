'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeNavHref, type NavItem } from '@/lib/ui/personas';

// The persona's pages under the top bar, with the current one underlined. A layout does not render
// again on navigation, so the current page is read here, in the browser.

export function SectionNav({ items, label }: { items: readonly NavItem[]; label: string }) {
  const pathname = usePathname();
  const active = activeNavHref(items, pathname);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  return (
    <nav aria-label={label} className="-mx-3 flex h-11 items-stretch overflow-x-auto">
      {items.map(({ href, label: name }) => {
        const here = href === active;
        return (
          <Link
            key={href}
            href={href}
            // The page itself, or a page inside this section, such as one dispute.
            aria-current={here ? (path === href ? 'page' : 'true') : undefined}
            className={`flex items-center border-b-2 px-3 text-body font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-[-2px] ${
              here ? 'border-text text-text' : 'border-transparent text-muted hover:text-text'
            }`}
          >
            {name}
          </Link>
        );
      })}
    </nav>
  );
}
