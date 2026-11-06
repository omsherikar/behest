import { NextResponse } from 'next/server';
import { isPersona, SESSION_COOKIE, sessionCookie, sessionCookieOptions } from '@/lib/session';

// Starts and ends demo sessions for the persona picker on the home page.

/** `POST { persona }` sets the session cookie for that persona. */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const persona = typeof body === 'object' && body !== null && 'persona' in body ? body.persona : undefined;
  if (!isPersona(persona)) {
    return Response.json({ error: { message: 'Persona must be buyer, seller or operator.' } }, { status: 400 });
  }

  const response = new NextResponse(null, { status: 204 });
  response.cookies.set(SESSION_COOKIE, await sessionCookie(persona), sessionCookieOptions());
  return response;
}

/** Clears the session cookie. */
export async function DELETE() {
  const response = new NextResponse(null, { status: 204 });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
