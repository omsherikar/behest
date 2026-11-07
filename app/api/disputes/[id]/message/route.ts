import { eq } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb, appJwks, appPaypal, appUrl } from '@/lib/app-deps';
import { disputes } from '@/lib/db/schema';
import { isWordedRefusal, NarrativeRequest, NOT_JSON, uncitedClaims, WORDED_REFUSALS } from '@/lib/disputes/answer-request';
import { SendMessageError, type SendMessageErrorCode, sendAnswerToBuyer } from '@/lib/disputes/message';
import { assembleEvidencePack } from '@/lib/disputes/pack';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { BUYER_MESSAGE_LIMIT, clientAddress, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Sends the narrative the operator reviewed to the buyer as a message on the dispute, while PayPal
// has it as an inquiry and takes no evidence yet. It is checked as the evidence route checks a
// submission: the pack is built again from Behest's records, and a narrative citing an item the pack
// does not hold is refused, naming the claims to fix. A dispute PayPal takes no message on now, such
// as a claim, is refused with 422 and words saying what PayPal takes instead. The evidence stays
// unsubmitted, so it can still be submitted once the inquiry becomes a claim.

const ROUTE = 'dispute_message';

/** The status and operator-facing message for each refusal with a fixed message. Nothing PayPal sent reaches the client. */
const REFUSALS: Record<Exclude<SendMessageErrorCode, keyof typeof WORDED_REFUSALS>, [status: number, message: string]> = {
  unknown_dispute: [404, 'There is no such dispute.'],
  unmatched: [409, 'This dispute is not matched to a purchase, so Behest has no evidence for it.'],
  already_submitted: [409, 'Evidence for this dispute was already submitted, so no message was sent.'],
  paypal_refused: [502, 'PayPal refused the message. Check the dispute at PayPal before trying again.'],
  paypal_failed: [502, 'PayPal did not take the message. Send it again to retry.'],
};

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
const refuse = (code: keyof typeof REFUSALS) => error(...REFUSALS[code]);

/**
 * `POST { summary, claims }`: sends the narrative to the buyer and returns `{ narrative, messagedAt }`:
 * the narrative as sent after trimming, and when PayPal took it, as an ISO timestamp.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/disputes/[id]/message'>) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'operator');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:operator`, BUYER_MESSAGE_LIMIT)) {
    return error(429, 'Too many messages at once. Try again in a minute.');
  }

  const { id } = await ctx.params;
  // Dispute ids are UUIDs; Postgres would refuse anything else as an error rather than find nothing.
  if (!z.guid().safeParse(id).success) return refuse('unknown_dispute');

  const raw = await readBody(request, FORM_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, NOT_JSON);
  }
  const parsed = NarrativeRequest.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0].message);

  // Every setting this route needs is read before anything is stored.
  const base = appUrl();
  const paypal = appPaypal();
  const db = appDb();
  const jwks = await appJwks();

  const [dispute] = await db
    .select({ purchaseId: disputes.purchaseId, submittedAt: disputes.submittedAt })
    .from(disputes)
    .where(eq(disputes.id, id));
  if (!dispute) return refuse('unknown_dispute');
  if (!dispute.purchaseId) return refuse('unmatched');
  if (dispute.submittedAt) return refuse('already_submitted');

  const narrative = parsed.data;
  const uncited = uncitedClaims(narrative, await assembleEvidencePack(db, id, base, jwks));
  if (uncited) return error(400, uncited);

  let messagedAt: Date;
  try {
    messagedAt = await sendAnswerToBuyer({ db, paypal, now: () => new Date(), appUrl: base }, { disputeId: id, narrative });
  } catch (failure) {
    if (!(failure instanceof SendMessageError)) throw failure;
    // sendAnswerToBuyer has logged PayPal's own error, which never reaches the client.
    return isWordedRefusal(failure.code) ? error(WORDED_REFUSALS[failure.code], failure.message) : refuse(failure.code);
  }
  return Response.json({ narrative, messagedAt: messagedAt.toISOString() });
}
