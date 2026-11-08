import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPersona,
  isPersona,
  mayOpen,
  PERSONAS,
  personaRefusal,
  personaSections,
  requiredPersona,
  SESSION_COOKIE,
  sessionCookie,
  sessionCookieOptions,
} from '@/lib/session';

const SECRET = 'test-session-secret-at-least-32-characters';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Signs a payload the way an attacker who knows the secret would, to probe what getPersona accepts. */
function signRaw(payload: Record<string, unknown>, secret = SECRET) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(secret));
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('session cookie', () => {
  it.each(PERSONAS)('round trips the %s persona', async (persona) => {
    expect(await getPersona(await sessionCookie(persona))).toBe(persona);
  });

  it('gives null when the payload is swapped under the original signature', async () => {
    const [header, , signature] = (await sessionCookie('buyer')).split('.');
    const forged = Buffer.from(JSON.stringify({ persona: 'operator' })).toString('base64url');
    expect(await getPersona(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it('gives null when the signature is altered', async () => {
    const [header, payload, signature] = (await sessionCookie('seller')).split('.');
    // The first character carries six signature bits; the last one partly carries padding bits.
    const altered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(await getPersona(`${header}.${payload}.${altered}`)).toBeNull();
  });

  it('gives null for a cookie signed with another secret', async () => {
    expect(await getPersona(await signRaw({ persona: 'operator' }, 'some-other-secret-of-similar-length'))).toBeNull();
  });

  it('gives null for an unsigned token', async () => {
    const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
    expect(await getPersona(`${encode({ alg: 'none' })}.${encode({ persona: 'operator' })}.`)).toBeNull();
  });

  it('gives null for a validly signed token naming an unknown persona', async () => {
    expect(await getPersona(await signRaw({ persona: 'admin' }))).toBeNull();
  });

  it('gives null for a missing, empty or malformed cookie', async () => {
    expect(await getPersona(undefined)).toBeNull();
    expect(await getPersona('')).toBeNull();
    expect(await getPersona('not-a-jwt')).toBeNull();
  });

  it('expires after seven days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const cookie = await sessionCookie('buyer');

    vi.setSystemTime(Date.now() + SEVEN_DAYS_MS - 60_000);
    expect(await getPersona(cookie)).toBe('buyer');

    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(await getPersona(cookie)).toBeNull();
  });

  it('refuses to sign without SESSION_SECRET', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    await expect(sessionCookie('buyer')).rejects.toThrow(/SESSION_SECRET/);
  });

  it('is HTTP-only, SameSite Lax and lasts seven days', () => {
    expect(sessionCookieOptions()).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: SEVEN_DAYS_MS / 1000 });
  });

  it('is Secure in production only', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookieOptions().secure).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieOptions().secure).toBe(true);
  });
});

describe('isPersona', () => {
  it('accepts exactly the three personas', () => {
    expect(PERSONAS).toEqual(['buyer', 'seller', 'operator']);
    for (const persona of PERSONAS) expect(isPersona(persona)).toBe(true);
    for (const other of ['admin', 'Buyer', '', null, undefined, 1, {}]) expect(isPersona(other)).toBe(false);
  });
});

describe('requiredPersona', () => {
  it.each([
    ['/buyer', 'buyer'],
    ['/buyer/', 'buyer'],
    ['/buyer/shop', 'buyer'],
    ['/buyer/approvals/123', 'buyer'],
    ['/seller', 'seller'],
    ['/seller/orders', 'seller'],
    ['/ops', 'operator'],
    ['/ops/disputes', 'operator'],
    ['/ops/disputes/PP-D-1', 'operator'],
    ['/products', 'operator'],
    ['/plans', 'operator'],
    ['/invoices', 'operator'],
    ['/transactions', 'operator'],
    ['/balances', 'operator'],
    ['/dashboard', 'any'],
    ['/dashboard/', 'any'],
  ])('%s needs the %s persona', (pathname, persona) => {
    expect(requiredPersona(pathname)).toBe(persona);
  });

  it.each(['/', '/dashboards', '/api/session', '/buyers', '/sellerx', '/operations', '/opsx/disputes', '/shop/buyer', '/constructor', '/__proto__'])(
    '%s is open to everyone',
    (pathname) => {
      expect(requiredPersona(pathname)).toBeNull();
    },
  );
});

describe('personaSections', () => {
  it('names every section that needs a persona, and only those', () => {
    const sections = personaSections();
    expect(sections).toEqual(['buyer', 'seller', 'ops', 'products', 'plans', 'invoices', 'transactions', 'balances', 'dashboard']);
    for (const section of sections) expect(requiredPersona(`/${section}`)).not.toBeNull();
  });
});

describe('mayOpen', () => {
  it('lets anyone, signed in or not, open a page with no requirement', () => {
    expect(mayOpen(null, null)).toBe(true);
    for (const persona of PERSONAS) expect(mayOpen(null, persona)).toBe(true);
  });

  it('lets every persona open a page open to any persona, but not a signed-out visitor', () => {
    for (const persona of PERSONAS) expect(mayOpen('any', persona)).toBe(true);
    expect(mayOpen('any', null)).toBe(false);
  });

  it('lets only the matching persona open a persona page', () => {
    expect(mayOpen('seller', 'seller')).toBe(true);
    expect(mayOpen('seller', 'buyer')).toBe(false);
    expect(mayOpen('seller', 'operator')).toBe(false);
    expect(mayOpen('seller', null)).toBe(false);
  });
});

describe('personaRefusal', () => {
  const requestWith = (cookie?: string) =>
    new NextRequest('http://localhost/api/mandates/compile', {
      headers: cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` },
    });

  it('lets a request through when its session holds the required persona', async () => {
    expect(await personaRefusal(requestWith(await sessionCookie('buyer')), 'buyer')).toBeNull();
  });

  it.each([undefined, 'not-a-signed-cookie'])('answers 401 to a request with cookie %s', async (cookie) => {
    const refusal = await personaRefusal(requestWith(cookie), 'buyer');
    expect(refusal?.status).toBe(401);
    expect(await refusal?.json()).toEqual({ error: { message: 'Pick a persona on the home page first.' } });
  });

  it.each(['seller', 'operator'] as const)('answers 403 to the %s on a buyer route', async (persona) => {
    const refusal = await personaRefusal(requestWith(await sessionCookie(persona)), 'buyer');
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({ error: { message: 'Only the buyer persona can do this.' } });
  });
});
