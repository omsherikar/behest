import { connection, type NextRequest } from 'next/server';
import { appDb, appUrl, demoBuyerId } from '@/lib/app-deps';
import type { MandatePolicy } from '@/lib/domain/policy';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { MandateConfirmError } from '@/lib/mandate/confirm';
import { isConfirmToken } from '@/lib/mandate/confirm-token';
import { signingOptions } from '@/lib/mandate/passkey';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Starts the buyer signing a mandate with their passkey: the WebAuthn options whose challenge
// commits to the mandate the policy becomes, and the ticket the confirm route checks the signature
// against. Like the confirm, it takes only a policy from a compile that left no question open, which
// the confirm token from that compile proves.

const ROUTE = 'mandate_sign_options';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `POST { text, policy, confirmToken }`: `{ options, ticket }` for the buyer's passkey to sign the
 * mandate. Answers 409 with the code `no_passkey` when the buyer has no passkey to sign with yet.
 */
export async function POST(request: NextRequest) {
  // Reads the database on every request, never at build time.
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
  if (!isObject(body) || typeof body.text !== 'string' || !isObject(body.policy)) {
    return error(400, 'Send the mandate text and the policy compiled from it.');
  }
  const { text, policy, confirmToken } = body;
  if (!isConfirmToken(confirmToken, text, policy)) return error(409, 'answer the open questions first');

  const origin = appUrl();
  const db = appDb();
  const buyerId = await demoBuyerId(db);
  let result: Awaited<ReturnType<typeof signingOptions>>;
  try {
    // signingOptions validates the policy itself, as the confirm will, and refuses one that is not a MandatePolicy.
    result = await signingOptions({ db, origin, now: () => new Date() }, { buyerId, policy: policy as MandatePolicy });
  } catch (failure) {
    if (failure instanceof MandateConfirmError) return error(400, failure.message);
    throw failure;
  }
  if (!result.ok) {
    return Response.json({ error: { code: 'no_passkey', message: 'Register a passkey first.' } }, { status: 409 });
  }
  return Response.json({ options: result.options, ticket: result.ticket });
}
