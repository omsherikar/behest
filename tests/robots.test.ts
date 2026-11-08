import { expect, it } from 'vitest';
import robots from '@/app/robots';
import { personaSections } from '@/lib/session';

const rules = () => {
  const { rules } = robots();
  if (Array.isArray(rules)) throw new Error('robots.ts gives one rule for every crawler');
  return rules;
};

it('applies one rule to every crawler', () => {
  expect(rules().userAgent).toBe('*');
});

it('lets crawlers read the public pages and the seller catalogs open to outside agents', () => {
  expect(rules().allow).toEqual(['/', '/api/sellers/']);
});

it('keeps crawlers off every persona section and the rest of the API', () => {
  const disallow = rules().disallow;
  expect(disallow).toContain('/api/');
  for (const section of personaSections()) expect(disallow).toContain(`/${section}`);
});

it('leaves the security page, llms.txt and the public key set open', () => {
  const disallow = [rules().disallow ?? []].flat();
  for (const path of ['/security', '/llms.txt', '/.well-known/jwks.json']) {
    expect(disallow.some((prefix) => path.startsWith(prefix))).toBe(false);
  }
});
