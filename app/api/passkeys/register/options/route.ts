import { connection, type NextRequest } from 'next/server';
import { appDb, appUrl, demoBuyerId } from '@/lib/app-deps';
import { registrationOptions } from '@/lib/passkeys/register';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Starts registering a passkey for the buyer: the WebAuthn options for the browser, and the ticket
// that carries the challenge Behest issued to the verify route. The request body is never read.

const ROUTE = 'passkey_register_options';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** `POST`: `{ options, ticket }` for registering a new passkey for the buyer. */
export async function POST(request: NextRequest) {
  // Reads the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:buyer`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const origin = appUrl();
  const db = appDb();
  const buyerId = await demoBuyerId(db);
  return Response.json(await registrationOptions({ db, origin, now: () => new Date() }, buyerId));
}
