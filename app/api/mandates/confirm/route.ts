import { eq, ne } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { appDb, appPaypal, appSigner, appUrl, demoBuyerId } from '@/lib/app-deps';
import { wallets } from '@/lib/db/schema';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import type { MandatePolicy } from '@/lib/domain/policy';
import { confirmMandate, MandateConfirmError, type MandateConfirmErrorCode } from '@/lib/mandate/confirm';
import { isConfirmToken } from '@/lib/mandate/confirm-token';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Signs the buyer's mandate, then starts linking their PayPal wallet unless one is already linked: it
// creates a vault setup token for the buyer to approve at PayPal and keeps it on the buyer's one wallet
// row, as pending, for the wallet return route to finish. A linked wallet stays linked and pays within
// the new mandate. Only a policy from a compile that left no question open is signed, which the
// confirm token from that compile proves.

const ROUTE = 'mandate_confirm';

const STATUS: Record<MandateConfirmErrorCode, number> = { invalid_policy: 400, expired: 400, unknown_buyer: 404 };

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `POST { text, policy, confirmToken }`: signs the mandate and returns `{ mandateId, approveUrl }`,
 * where `approveUrl` is null when the buyer's wallet is already linked.
 */
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
  if (!isObject(body) || typeof body.text !== 'string' || !isObject(body.policy)) {
    return error(400, 'Send the mandate text and the policy compiled from it.');
  }
  const { text, policy, confirmToken } = body;
  if (!isConfirmToken(confirmToken, text, policy)) return error(409, 'answer the open questions first');

  // Every setting this route needs (APP_URL, the signing key and the PayPal credentials) is read
  // before the mandate is signed, so a missing one fails the request with nothing stored.
  const base = appUrl();
  const signer = await appSigner();
  const paypal = appPaypal();
  const db = appDb();
  const buyerId = await demoBuyerId(db);

  let mandateId: string;
  try {
    // confirmMandate validates the policy itself and refuses one that is not a MandatePolicy.
    ({ mandateId } = await confirmMandate(
      { db, signer, now: () => new Date() },
      { buyerId, text, policy: policy as MandatePolicy },
    ));
  } catch (failure) {
    if (failure instanceof MandateConfirmError) return error(STATUS[failure.code], failure.message);
    throw failure;
  }

  const [wallet] = await db.select({ status: wallets.status }).from(wallets).where(eq(wallets.buyerId, buyerId));
  if (wallet?.status === 'linked') return Response.json({ mandateId, approveUrl: null });

  let setup: { id: string; approveUrl: string; customerId: string };
  try {
    setup = await paypal.createSetupToken({
      returnUrl: `${base}/api/wallet/return`,
      cancelUrl: `${base}/buyer?wallet=cancelled`,
      description: 'Let your Behest agent pay within your mandate',
    });
  } catch (failure) {
    console.error('[mandates] PayPal could not start the wallet link:', failure);
    return error(502, 'Your mandate is signed, but PayPal could not start linking your wallet. Confirm again to retry.');
  }

  // A buyer has one wallet row: a new link replaces a pending or revoked one, never a linked one, so
  // a wallet linked while PayPal answered stays linked and this setup token goes unused.
  const pending = {
    status: 'pending' as const,
    setupTokenId: setup.id,
    paypalCustomerId: setup.customerId,
    paymentTokenId: null,
    linkedAt: null,
  };
  const stored = await db
    .insert(wallets)
    .values({ buyerId, ...pending })
    .onConflictDoUpdate({ target: wallets.buyerId, set: pending, setWhere: ne(wallets.status, 'linked') })
    .returning({ id: wallets.id });

  return Response.json({ mandateId, approveUrl: stored.length > 0 ? setup.approveUrl : null });
}
