import { eq } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb, appJwks, appPaypal, appUrl } from '@/lib/app-deps';
import { disputes } from '@/lib/db/schema';
import { isWordedRefusal, NarrativeRequest, NOT_JSON, uncitedClaims, WORDED_REFUSALS } from '@/lib/disputes/answer-request';
import { assembleEvidencePack } from '@/lib/disputes/pack';
import { SubmitEvidenceError, type SubmitEvidenceErrorCode, submitEvidence } from '@/lib/disputes/submit';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { personaRefusal } from '@/lib/session';

// Submits the narrative the operator reviewed to PayPal as the dispute's evidence, exactly as the
// operator sent it. The evidence pack is built again from Behest's records, and a narrative citing
// an item the pack does not hold is refused, naming the claims to fix: submitting cannot be undone,
// so nothing the operator approved is dropped on the way to PayPal. A dispute PayPal takes no
// evidence on yet, such as an inquiry, is refused with 422 and words saying what PayPal takes instead.

/** The status and operator-facing message for each refusal with a fixed message. Nothing PayPal sent reaches the client. */
const REFUSALS: Record<Exclude<SubmitEvidenceErrorCode, keyof typeof WORDED_REFUSALS>, [status: number, message: string]> = {
  unknown_dispute: [404, 'There is no such dispute.'],
  unmatched: [409, 'This dispute is not matched to a purchase, so Behest has no evidence for it.'],
  already_submitted: [409, 'Evidence for this dispute was already submitted.'],
  paypal_refused: [502, 'PayPal refused the evidence. Check the dispute at PayPal before trying again.'],
  paypal_failed: [502, 'PayPal did not take the evidence. Submit it again to retry.'],
};

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
const refuse = (code: keyof typeof REFUSALS) => error(...REFUSALS[code]);

/** `POST { summary, claims }`: submits the narrative and returns `{ narrative }`, as submitted after trimming. */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/disputes/[id]/evidence'>) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'operator');
  if (refusal) return refusal;

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

  try {
    await submitEvidence({ db, paypal, now: () => new Date(), appUrl: base }, { disputeId: id, narrative });
  } catch (failure) {
    if (!(failure instanceof SubmitEvidenceError)) throw failure;
    // submitEvidence has logged PayPal's own error, which never reaches the client.
    return isWordedRefusal(failure.code) ? error(WORDED_REFUSALS[failure.code], failure.message) : refuse(failure.code);
  }
  return Response.json({ narrative });
}
