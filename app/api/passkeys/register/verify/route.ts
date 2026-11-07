import { connection, type NextRequest } from 'next/server';
import { appDb, appUrl, demoBuyerId } from '@/lib/app-deps';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { registerPasskey } from '@/lib/passkeys/register';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Finishes registering a passkey for the buyer: verifies the browser's registration against the
// challenge in the ticket from the options route and stores the passkey. Every way a registration
// can fail gets the same answer, so it tells a caller nothing about why.

const ROUTE = 'passkey_register_verify';

const NOT_REGISTERED = 'Your passkey could not be registered. Try again.';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `POST { response, ticket }`: stores the passkey and returns `{ credentialId }`. */
export async function POST(request: NextRequest) {
  // Writes to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:buyer`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const raw = await readBody(request, FORM_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  if (!isObject(body)) return error(400, 'Send the passkey and the ticket it answers.');

  const origin = appUrl();
  const db = appDb();
  const buyerId = await demoBuyerId(db);
  const result = await registerPasskey(
    { db, origin, now: () => new Date() },
    { buyerId, response: body.response, ticket: body.ticket },
  );
  if (!result.ok) return error(400, NOT_REGISTERED);
  return Response.json({ credentialId: result.credentialId });
}
