import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

/**
 * Sends a visitor without the operator persona to the persona picker. The proxy already does this;
 * each operator page checks again so it stays safe on its own.
 */
export async function requireOperator(): Promise<void> {
  const persona = await getPersona((await cookies()).get(SESSION_COOKIE)?.value);
  if (persona !== 'operator') redirect('/');
}
