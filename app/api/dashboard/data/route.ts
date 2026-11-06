import { connection, type NextRequest } from 'next/server';
import { getDb } from '@/lib/db/client';
import { loadDashboardData } from '@/lib/dashboard/scope';
import { searchTransactions } from '@/lib/paypal';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

// The dashboard's rows, scoped to the persona in the session cookie (see lib/dashboard/scope.ts).
// The operator's rows include PayPal transactions; when Transaction Search fails, the rest still
// comes back, with a warning.
export async function GET(request: NextRequest) {
  // Reads the database on every request, never at build time.
  await connection();

  const persona = await getPersona(request.cookies.get(SESSION_COOKIE)?.value);
  if (!persona) {
    return Response.json({ error: { message: 'Pick a persona on the home page first.' } }, { status: 401 });
  }

  const data = await loadDashboardData(getDb(), persona, { loadTransactions: searchTransactions });
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
