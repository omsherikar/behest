'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SpotlightNavbar } from '@/components/vui/spotlight-navbar';
import { activeNavHref, type NavItem } from '@/lib/ui/personas';

// The persona's pages in the top bar, as a spotlight nav with a glow under the current one. A layout
// does not render again on navigation, so the current page is read here, in the browser, and the
// glow glides from page to page.

export function SectionNav({ items, label }: { items: readonly NavItem[]; label: string }) {
  const pathname = usePathname();
  const active = activeNavHref(items, pathname);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const activeIndex = items.findIndex(({ href }) => href === active);

  return (
    <SpotlightNavbar
      label={label}
      link={Link}
      activeIndex={activeIndex === -1 ? null : activeIndex}
      items={items.map(({ href, label: name }) => ({
        href,
        label: name,
        // The page itself, or a page inside this section, such as one dispute.
        current: href === active ? (path === href ? 'page' : 'true') : undefined,
      }))}
    />
  );
}
