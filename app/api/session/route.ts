import { NextResponse } from 'next/server';
import { readBody } from '@/lib/http/read-body';
import { isPersona, SESSION_COOKIE, sessionCookie, sessionCookieOptions } from '@/lib/session';

// Starts and ends demo sessions for the persona picker on the home page.

/** The largest body read. The only one accepted is `{"persona":"..."}`. */
const MAX_BODY_BYTES = 1024;

/** `POST { persona }` sets the session cookie for that persona. A body over 1 KiB gets 413, unread past the limit. */
export async function POST(request: Request) {
  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) return Response.json({ error: { message: 'This request is too large.' } }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
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
