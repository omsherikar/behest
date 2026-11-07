import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

/**
 * Sends a visitor without the buyer persona to the persona picker. The proxy already does this;
 * each buyer page checks again so it stays safe on its own.
 */
export async function requireBuyer(): Promise<void> {
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (persona !== 'buyer') redirect('/');
}
