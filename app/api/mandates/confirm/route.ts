import { connection, type NextRequest } from 'next/server';
import { appDb, appPaypal, appSigner, appUrl, demoBuyerId } from '@/lib/app-deps';
import { wallets } from '@/lib/db/schema';
import type { MandatePolicy } from '@/lib/domain/policy';
import { confirmMandate, MandateConfirmError, type MandateConfirmErrorCode } from '@/lib/mandate/confirm';
import { isConfirmToken } from '@/lib/mandate/confirm-token';
import { personaRefusal } from '@/lib/session';

// Signs the buyer's mandate, then starts linking their PayPal wallet: it creates a vault setup token
// for the buyer to approve at PayPal and keeps it on the buyer's one wallet row, as pending, for the
// wallet return route to finish. Only a policy from a compile that left no question open is signed,
// which the confirm token from that compile proves.

const STATUS: Record<MandateConfirmErrorCode, number> = { invalid_policy: 400, expired: 400, unknown_buyer: 404 };

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `POST { text, policy, confirmToken }`: signs the mandate and returns `{ mandateId, approveUrl }`. */
export async function POST(request: NextRequest) {
  // Writes to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;

  const body: unknown = await request.json().catch(() => undefined);
  if (!isObject(body) || typeof body.text !== 'string' || !isObject(body.policy)) {
    return error(400, 'Send the mandate text and the policy compiled from it.');
  }
  const { text, policy, confirmToken } = body;
  if (!isConfirmToken(confirmToken, text, policy)) return error(409, 'answer the open questions first');

  // Read before anything is signed, so a missing setting stores nothing.
  const base = appUrl();
  const signer = await appSigner();
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

  let setup: { id: string; approveUrl: string; customerId: string };
  try {
    setup = await appPaypal().createSetupToken({
      returnUrl: `${base}/api/wallet/return`,
      cancelUrl: `${base}/buyer?wallet=cancelled`,
      description: 'Let your Behest agent pay within your mandate',
    });
  } catch (failure) {
    console.error('[mandates] PayPal could not start the wallet link:', failure);
    return error(502, 'Your mandate is signed, but PayPal could not start linking your wallet. Confirm again to retry.');
  }

  // A buyer has one wallet row, so a new link replaces the last one until the buyer approves it.
  const pending = {
    status: 'pending' as const,
    setupTokenId: setup.id,
    paypalCustomerId: setup.customerId,
    paymentTokenId: null,
    linkedAt: null,
  };
  await db
    .insert(wallets)
    .values({ buyerId, ...pending })
    .onConflictDoUpdate({ target: wallets.buyerId, set: pending });

  return Response.json({ mandateId, approveUrl: setup.approveUrl });
}
