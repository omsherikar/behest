import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mayOpen, PERSONAS, requiredPersona } from '@/lib/session';
import { activeNavHref, PERSONA_INFO, personaInfo } from '@/lib/ui/personas';

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Whether the app has a page at `href`, outside route groups. */
const hasPage = (href: string) => existsSync(path.join(ROOT, 'app', ...href.split('/').filter(Boolean), 'page.tsx'));

describe('the personas the interface shows', () => {
  it('cover every session persona, in the same order', () => {
    expect(PERSONA_INFO.map((info) => info.persona)).toEqual([...PERSONAS]);
  });

  it('give each persona its section nav', () => {
    const labels = (persona: (typeof PERSONAS)[number]) => personaInfo(persona).nav.map((item) => item.label);
    expect(labels('buyer')).toEqual(['Mandate', 'Shop', 'Approvals', 'Ledger']);
    expect(labels('seller')).toEqual(['Shop', 'Catalog', 'Orders']);
    expect(labels('operator')).toEqual(['Disputes', 'Dashboard']);
  });

  it.each(PERSONA_INFO.map((info) => [info.persona, info] as const))(
    'send the %s only to pages that exist and that the persona may open',
    (persona, info) => {
      for (const href of [info.home, ...info.nav.map((item) => item.href)]) {
        expect(hasPage(href), href).toBe(true);
        expect(mayOpen(requiredPersona(href), persona), href).toBe(true);
      }
    },
  );

  it('start each persona on the first page of its nav', () => {
    for (const info of PERSONA_INFO) expect(info.home).toBe(info.nav[0].href);
  });
});

describe('activeNavHref', () => {
  const buyer = personaInfo('buyer').nav;
  const operator = personaInfo('operator').nav;

  it('marks the page itself', () => {
    expect(activeNavHref(buyer, '/buyer')).toBe('/buyer');
    expect(activeNavHref(buyer, '/buyer/ledger')).toBe('/buyer/ledger');
  });

  it('prefers the longest matching path over its parent', () => {
    expect(activeNavHref(buyer, '/buyer/shop')).toBe('/buyer/shop');
  });

  it('marks the parent of a page the nav does not list', () => {
    expect(activeNavHref(operator, '/ops/disputes/3f1c2a')).toBe('/ops/disputes');
  });

  it('ignores a trailing slash', () => {
    expect(activeNavHref(buyer, '/buyer/approvals/')).toBe('/buyer/approvals');
  });

  it('does not match a path that only shares a prefix', () => {
    expect(activeNavHref(buyer, '/buyers')).toBeNull();
    expect(activeNavHref(operator, '/ops')).toBeNull();
  });
});
