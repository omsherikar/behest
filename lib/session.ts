import { jwtVerify, SignJWT } from 'jose';

// Demo sessions. A visitor picks a persona on the home page and gets it back as a signed,
// HTTP-only cookie. Anyone may pick any persona: the signature only guarantees that the persona
// came from this app (app/api/session), so a hand-edited cookie never reads as a persona.

export const PERSONAS = ['buyer', 'seller', 'operator'] as const;
export type Persona = (typeof PERSONAS)[number];

export const SESSION_COOKIE = 'behest_session';
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

export function isPersona(value: unknown): value is Persona {
  return PERSONAS.includes(value as Persona);
}

function sessionKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is required to sign and read session cookies');
  return new TextEncoder().encode(secret);
}

/** The value of the session cookie for `persona`: an HS256 JWT that expires in seven days. */
export async function sessionCookie(persona: Persona): Promise<string> {
  return new SignJWT({ persona })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(sessionKey());
}

/** The persona in a session cookie, or null when it is missing, expired, tampered with or unknown. */
export async function getPersona(cookieValue: string | undefined): Promise<Persona | null> {
  if (!cookieValue) return null;
  // Outside the try: a missing secret is a configuration error, not an invalid cookie.
  const key = sessionKey();
  try {
    const { payload } = await jwtVerify(cookieValue, key, { algorithms: ['HS256'] });
    return isPersona(payload.persona) ? payload.persona : null;
  } catch {
    return null;
  }
}

/** Attributes for the session cookie. Secure only in production, so it also works on http://localhost. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

// The first path segment of each persona's pages. The starter's PayPal data pages show the whole
// merchant account, so they belong to the operator.
const SECTION_PERSONA = new Map<string, Persona>([
  ['buyer', 'buyer'],
  ['seller', 'seller'],
  ['ops', 'operator'],
  ['products', 'operator'],
  ['plans', 'operator'],
  ['invoices', 'operator'],
  ['transactions', 'operator'],
  ['balances', 'operator'],
]);

/** The persona a page path needs, or null when everyone may open it. Used by proxy.ts. */
export function requiredPersona(pathname: string): Persona | null {
  return SECTION_PERSONA.get(pathname.split('/')[1]) ?? null;
}
