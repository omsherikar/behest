import { NextResponse, type NextRequest } from 'next/server';
import { getPersona, requiredPersona, SESSION_COOKIE } from '@/lib/session';

// Sends visitors without the matching persona back to the persona picker. This is an optimistic
// check on the signed cookie only; routes that read or change data check the persona themselves.
export async function proxy(request: NextRequest) {
  const required = requiredPersona(request.nextUrl.pathname);
  if (!required) return NextResponse.next();

  const persona = await getPersona(request.cookies.get(SESSION_COOKIE)?.value);
  if (persona === required) return NextResponse.next();
  return NextResponse.redirect(new URL('/', request.url));
}

// Runs on every page, so requiredPersona stays the one list of protected sections. API routes,
// build assets and the favicon are skipped.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
