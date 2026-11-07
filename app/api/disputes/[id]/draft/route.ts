import { and, eq, isNull } from 'drizzle-orm';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb, appPaypal, appUrl, llmDeps } from '@/lib/app-deps';
import { disputes } from '@/lib/db/schema';
import { draftNarrative } from '@/lib/disputes/narrative';
import { assembleEvidencePack } from '@/lib/disputes/pack';
import type { LlmFailure } from '@/lib/llm/client';
import type { DisputeDetail } from '@/lib/paypal/port';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { personaRefusal } from '@/lib/session';

// Drafts the narrative an operator reviews before answering a dispute. The evidence pack is built
// from Behest's records and stored as the dispute's evidence snapshot before PayPal or the model is
// asked, so when either fails the operator can still write the narrative from the evidence items.
// The draft itself is only returned: the dispute's narrative column holds what was submitted, and
// a draft never overwrites it. Once evidence is submitted, nothing more is drafted or stored.

const ROUTE = 'dispute_draft';

const FROM_EVIDENCE = 'write the narrative yourself from the evidence items';

/** The fixed words for each way the model call fails. Nothing the model wrote reaches the operator. */
const MODEL_FAILURES: Record<LlmFailure, string> = {
  refusal: 'The model refused to draft a narrative. Write it yourself from the evidence items, or draft again.',
  max_tokens: `The model ran out of room before it finished. Draft again, or ${FROM_EVIDENCE}.`,
  invalid_output:
    'The model answered with something other than a narrative. Draft again, or write it yourself from the evidence items.',
  api_error: `The model could not be reached or failed. Draft again in a minute, or ${FROM_EVIDENCE}.`,
  spend_cap: "Today's budget for model calls is spent. Write the narrative yourself from the evidence items, or draft again tomorrow.",
};

const PAYPAL_FAILED = `PayPal did not return this dispute, so nothing was drafted. Draft again in a minute, or ${FROM_EVIDENCE}.`;
const UNKNOWN = 'There is no such dispute.';
const UNMATCHED = 'This dispute is not matched to a purchase, so Behest has no evidence for it.';
const SUBMITTED = 'Evidence for this dispute was already submitted, so it cannot be drafted again.';

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** `POST` with no body: drafts the dispute's narrative and returns `{ pack, narrative }`. */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/disputes/[id]/draft'>) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'operator');
  if (refusal) return refusal;
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:operator`, MODEL_ROUTE_LIMIT)) {
    return error(429, 'Too many drafts at once. Try again in a minute.');
  }

  const { id } = await ctx.params;
  // Dispute ids are UUIDs; Postgres would refuse anything else as an error rather than find nothing.
  if (!z.guid().safeParse(id).success) return error(404, UNKNOWN);

  // Every setting this route needs (APP_URL, the PayPal credentials and the Claude client) is read
  // before anything is stored.
  const base = appUrl();
  const paypal = appPaypal();
  const deps = llmDeps();
  const db = appDb();

  const [dispute] = await db
    .select({ paypalDisputeId: disputes.paypalDisputeId, purchaseId: disputes.purchaseId, submittedAt: disputes.submittedAt })
    .from(disputes)
    .where(eq(disputes.id, id));
  if (!dispute) return error(404, UNKNOWN);
  if (!dispute.purchaseId) return error(409, UNMATCHED);
  if (dispute.submittedAt) return error(409, SUBMITTED);

  const pack = await assembleEvidencePack(db, id, base);
  // Only while nothing is submitted, so a submission made since the check above keeps its pack.
  const stored = await db
    .update(disputes)
    .set({ evidencePack: pack })
    .where(and(eq(disputes.id, id), isNull(disputes.submittedAt)))
    .returning({ id: disputes.id });
  if (stored.length === 0) return error(409, SUBMITTED);

  let detail: DisputeDetail;
  try {
    detail = await paypal.getDispute(dispute.paypalDisputeId);
  } catch (failure) {
    console.error('[disputes] PayPal did not return the dispute:', failure);
    return error(502, PAYPAL_FAILED);
  }

  const drafted = await draftNarrative(deps, pack, detail);
  if (!drafted.ok) {
    return Response.json({ error: { code: drafted.error, message: MODEL_FAILURES[drafted.error] } }, { status: 502 });
  }
  return Response.json({ pack, narrative: drafted.value });
}
