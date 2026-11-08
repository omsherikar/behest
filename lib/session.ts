import { jwtVerify, SignJWT } from 'jose';
import type { NextRequest } from 'next/server';

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

/**
 * The response refusing an API request whose session does not hold `required`: 401 with no
 * persona, 403 with another one. Null when the request may go on. The proxy guards pages only, so
 * each API route checks its persona with this itself.
 */
export async function personaRefusal(request: NextRequest, required: Persona): Promise<Response | null> {
  const persona = await getPersona(request.cookies.get(SESSION_COOKIE)?.value);
  if (persona === required) return null;
  const [status, message] =
    persona === null ? [401, 'Pick a persona on the home page first.'] : [403, `Only the ${required} persona can do this.`];
  return Response.json({ error: { message } }, { status });
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

/** Who may open a page: one persona, or `any` for every persona. */
export type PageAccess = Persona | 'any';

// The first path segment of each persona's pages. The starter's PayPal data pages show the whole
// merchant account, so they belong to the operator. The dashboard scopes its data to whoever is
// viewing, so every persona may open it.
const SECTION_ACCESS = new Map<string, PageAccess>([
  ['buyer', 'buyer'],
  ['seller', 'seller'],
  ['ops', 'operator'],
  ['products', 'operator'],
  ['plans', 'operator'],
  ['invoices', 'operator'],
  ['transactions', 'operator'],
  ['balances', 'operator'],
  ['dashboard', 'any'],
]);

/** The first path segment of every section a visitor needs a persona to open. Used by robots.ts. */
export function personaSections(): string[] {
  return [...SECTION_ACCESS.keys()];
}

/** Who may open a page path, or null when everyone may, signed in or not. Used by proxy.ts. */
export function requiredPersona(pathname: string): PageAccess | null {
  return SECTION_ACCESS.get(pathname.split('/')[1]) ?? null;
}

/** Whether a visitor with `persona` (null when signed out) may open a page that needs `required`. */
export function mayOpen(required: PageAccess | null, persona: Persona | null): boolean {
  if (required === null) return true;
  if (persona === null) return false;
  return required === 'any' || required === persona;
}
