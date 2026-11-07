import { eq } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb, appJwks, appPaypal, appUrl } from '@/lib/app-deps';
import { disputes } from '@/lib/db/schema';
import type { Narrative } from '@/lib/disputes/narrative';
import type { AnswerRefusalCode } from '@/lib/disputes/answerable';
import { assembleEvidencePack, EVIDENCE_IDS, type EvidencePack } from '@/lib/disputes/pack';
import { SubmitEvidenceError, type SubmitEvidenceErrorCode, submitEvidence } from '@/lib/disputes/submit';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { personaRefusal } from '@/lib/session';

// Submits the narrative the operator reviewed to PayPal as the dispute's evidence, exactly as the
// operator sent it. The evidence pack is built again from Behest's records, and a narrative citing
// an item the pack does not hold is refused, naming the claims to fix: submitting cannot be undone,
// so nothing the operator approved is dropped on the way to PayPal. A dispute PayPal takes no
// evidence on yet, such as an inquiry, is refused with 422 and words saying what PayPal takes instead.

/** `items` as a list in a sentence, such as `a, b and c`. */
const inProse = (items: readonly string[], conjunction: 'and' | 'or') =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;

const NOT_JSON = 'Send the narrative as JSON.';
const SHAPE = 'Send the narrative as a summary and a list of claims.';
const CITE = `Cite evidence items by their ids: ${inProse(EVIDENCE_IDS, 'or')}.`;

/** One claim: its text, and the evidence items that show it, each cited once. */
const Claim = z.strictObject(
  {
    text: z.string({ error: SHAPE }).trim().min(1, { error: 'Every claim needs its text.' }),
    evidenceIds: z
      .array(z.enum(EVIDENCE_IDS, { error: CITE }), { error: SHAPE })
      .min(1, { error: 'Every claim must cite at least one evidence item.' })
      .refine((ids) => new Set(ids).size === ids.length, { error: 'Cite each evidence item once in a claim.' }),
  },
  { error: SHAPE },
);

/** A narrative as the operator edited it, in the shape of a Narrative. */
const NarrativeRequest = z.strictObject(
  {
    summary: z.string({ error: SHAPE }).trim().min(1, { error: 'Write a summary.' }),
    claims: z.array(Claim, { error: SHAPE }).min(1, { error: 'Write at least one claim.' }),
  },
  { error: SHAPE },
);

/**
 * The status of each refusal submitEvidence words for the operator itself: notes too long, and a
 * dispute PayPal takes no evidence on now or could not be read to check. Nothing PayPal sent is in them.
 */
const WORDED: Record<'notes_too_long' | AnswerRefusalCode, number> = {
  notes_too_long: 400,
  inquiry: 422,
  claim: 422,
  closed: 422,
  not_taking_answers: 422,
  check_failed: 502,
};
const isWorded = (code: SubmitEvidenceErrorCode): code is keyof typeof WORDED => Object.hasOwn(WORDED, code);

/** The status and operator-facing message for each refusal with a fixed message. Nothing PayPal sent reaches the client. */
const REFUSALS: Record<Exclude<SubmitEvidenceErrorCode, keyof typeof WORDED>, [status: number, message: string]> = {
  unknown_dispute: [404, 'There is no such dispute.'],
  unmatched: [409, 'This dispute is not matched to a purchase, so Behest has no evidence for it.'],
  already_submitted: [409, 'Evidence for this dispute was already submitted.'],
  paypal_refused: [502, 'PayPal refused the evidence. Check the dispute at PayPal before trying again.'],
  paypal_failed: [502, 'PayPal did not take the evidence. Submit it again to retry.'],
};

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
const refuse = (code: keyof typeof REFUSALS) => error(...REFUSALS[code]);

/**
 * Why the narrative cannot be submitted as it stands: the claims, numbered from 1, that cite items
 * the pack does not hold. Null when every citation names an item of the pack.
 */
function uncitedClaims(narrative: Narrative, pack: EvidencePack): string | null {
  const held = pack.items.map((item) => item.id);
  const uncited = narrative.claims.flatMap(({ evidenceIds }, index) => {
    const missing = evidenceIds.filter((id) => !held.includes(id));
    return missing.length > 0 ? [`claim ${index + 1} cites ${inProse(missing, 'and')}`] : [];
  });
  if (uncited.length === 0) return null;
  return `Some claims cite evidence this dispute does not have: ${uncited.join('; ')}. Its evidence is ${inProse(held, 'and')}.`;
}

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
    return isWorded(failure.code) ? error(WORDED[failure.code], failure.message) : refuse(failure.code);
  }
  return Response.json({ narrative });
}
