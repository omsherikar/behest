import { eq } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb, appPaypal, appUrl } from '@/lib/app-deps';
import { disputes } from '@/lib/db/schema';
import { dropUncited } from '@/lib/disputes/narrative';
import { assembleEvidencePack, EVIDENCE_IDS } from '@/lib/disputes/pack';
import { SubmitEvidenceError, type SubmitEvidenceErrorCode, submitEvidence } from '@/lib/disputes/submit';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { personaRefusal } from '@/lib/session';

// Submits the narrative the operator reviewed to PayPal as the dispute's evidence. The evidence
// pack is built again from Behest's records and the narrative keeps only its citations of items
// the pack holds, so an edited narrative can never cite evidence the dispute does not have.

const NOT_JSON = 'Send the narrative as JSON.';
const SHAPE = 'Send the narrative as a summary and a list of claims.';
const CITE = `Cite evidence items by their ids: ${EVIDENCE_IDS.slice(0, -1).join(', ')} or ${EVIDENCE_IDS.at(-1)}.`;
const NO_CLAIMS = 'No claim cites an evidence item this dispute has. Cite at least one before submitting.';

/** A narrative as the operator edited it, in the shape of a Narrative. */
const NarrativeRequest = z.strictObject(
  {
    summary: z.string({ error: SHAPE }).trim().min(1, { error: 'Write a summary.' }),
    claims: z.array(
      z.strictObject(
        {
          text: z.string({ error: SHAPE }).trim().min(1, { error: 'Every claim needs its text.' }),
          evidenceIds: z.array(z.enum(EVIDENCE_IDS, { error: CITE }), { error: SHAPE }),
        },
        { error: SHAPE },
      ),
      { error: SHAPE },
    ),
  },
  { error: SHAPE },
);

/** The status and operator-facing message for each refusal with a fixed message. Nothing PayPal sent reaches the client. */
const REFUSALS: Record<Exclude<SubmitEvidenceErrorCode, 'notes_too_long'>, [status: number, message: string]> = {
  unknown_dispute: [404, 'There is no such dispute.'],
  unmatched: [409, 'This dispute is not matched to a purchase, so Behest has no evidence for it.'],
  already_submitted: [409, 'Evidence for this dispute was already submitted.'],
  paypal_failed: [502, 'PayPal did not take the evidence. Submit it again to retry.'],
};

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
const refuse = (code: keyof typeof REFUSALS) => error(...REFUSALS[code]);

/** `POST { summary, claims }`: submits the narrative and returns `{ narrative }`, the narrative as submitted. */
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

  const [dispute] = await db
    .select({ purchaseId: disputes.purchaseId, submittedAt: disputes.submittedAt })
    .from(disputes)
    .where(eq(disputes.id, id));
  if (!dispute) return refuse('unknown_dispute');
  if (!dispute.purchaseId) return refuse('unmatched');
  if (dispute.submittedAt) return refuse('already_submitted');

  const narrative = dropUncited(parsed.data, await assembleEvidencePack(db, id, base));
  if (narrative.claims.length === 0) return error(400, NO_CLAIMS);

  try {
    await submitEvidence({ db, paypal, now: () => new Date(), appUrl: base }, { disputeId: id, narrative });
  } catch (failure) {
    if (!(failure instanceof SubmitEvidenceError)) throw failure;
    if (failure.code === 'notes_too_long') return error(400, failure.message);
    if (failure.code === 'paypal_failed') console.error('[disputes] PayPal did not take the evidence:', failure.cause);
    return refuse(failure.code);
  }
  return Response.json({ narrative });
}
