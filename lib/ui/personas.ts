import type { Persona } from '@/lib/session';

// The three demo personas as the interface shows them: a name, where each one starts, what a
// visitor can do there, and the section nav of its pages. Shared by the persona picker on the home
// page and the app shell's persona switcher and section nav. Pure data, so it bundles for the browser.

export type NavItem = { href: string; label: string };

export type PersonaInfo = {
  persona: Persona;
  /** The persona's name in the interface, such as "Buyer". */
  name: string;
  /** The page the persona starts on. */
  home: string;
  /** What a visitor can do as this persona, in one sentence. */
  does: string;
  /** The persona's pages, in the order the section nav lists them. */
  nav: readonly NavItem[];
};

export const PERSONA_INFO: readonly PersonaInfo[] = [
  {
    persona: 'buyer',
    name: 'Buyer',
    home: '/buyer',
    does: 'Write a mandate in plain words, send your agent shopping inside it and approve what it holds for you.',
    nav: [
      { href: '/buyer', label: 'Mandate' },
      { href: '/buyer/shop', label: 'Shop' },
      { href: '/buyer/approvals', label: 'Approvals' },
      { href: '/buyer/ledger', label: 'Ledger' },
    ],
  },
  {
    persona: 'seller',
    name: 'Seller',
    home: '/seller',
    does: 'List your products and accept the orders agents place, each one with a receipt you can verify.',
    nav: [
      { href: '/seller', label: 'Shop' },
      { href: '/seller/catalog', label: 'Catalog' },
      { href: '/seller/orders', label: 'Orders' },
    ],
  },
  {
    persona: 'operator',
    name: 'Operator',
    home: '/ops/disputes',
    does: 'Answer buyer disputes with evidence drawn from signed mandates and receipts.',
    nav: [
      { href: '/ops/disputes', label: 'Disputes' },
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
];

/** What the interface shows for `persona`. */
export function personaInfo(persona: Persona): PersonaInfo {
  const info = PERSONA_INFO.find((entry) => entry.persona === persona);
  if (!info) throw new Error(`no interface entry for the ${persona} persona`);
  return info;
}

/**
 * The nav item for the page at `pathname`: the item whose path is the page's path or a parent of
 * it, the longest one winning, so `/buyer/shop` marks Shop rather than Mandate (`/buyer`) and a
 * dispute at `/ops/disputes/123` marks Disputes. Null when no item matches.
 */
export function activeNavHref(items: readonly NavItem[], pathname: string): string | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  let best: string | null = null;
  for (const { href } of items) {
    const matches = path === href || path.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
