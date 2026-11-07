import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import { PayPalApiError } from '@/lib/paypal/http';
import type { PaypalPort } from '@/lib/paypal/port';
import { type AnswerRefusalCode, checkAnswerAtPaypal } from './answerable';
import type { Narrative } from './narrative';

// Submits the narrative an operator reviewed to PayPal as the dispute's evidence, exactly once
// (architecture section 5.5). PayPal gets it as plain-text notes: the summary, each claim with the
// evidence items it cites, and the signed receipt's id with where to verify it.
//
// PayPal takes evidence only once the dispute is a claim, so before anything is claimed the dispute
// is read live at PayPal and refused in plain words while it is an inquiry, under review or closed.
// When PayPal cannot be read, nothing is sent: evidence never goes to PayPal unchecked.
//
// A submission is claimed in the database first: a conditional update records the time and the
// narrative only while none is recorded, and commits before PayPal is asked, so no lock is held
// while PayPal answers and a second submission, even one made at the same moment, is refused. When
// PayPal fails or refuses, its error is logged and the claim is released so the operator can submit
// again. The client sends a fixed PayPal-Request-Id per dispute, so a retry after an answer that was
// lost is not applied twice.

/** The most characters PayPal takes in an evidence's notes. */
export const MAX_NOTES_CHARS = 2_000;

export type SubmitEvidenceErrorCode =
  | 'unknown_dispute'
  | 'unmatched'
  | 'already_submitted'
  | 'notes_too_long'
  | AnswerRefusalCode
  | 'paypal_refused'
  | 'paypal_failed';

/**
 * Why evidence was not submitted. The codes of AnswerRefusalCode say PayPal takes no evidence on the
 * dispute now, or could not be read to check, with the cause PayPal's read threw. `paypal_refused`
 * is PayPal answering the submission with a 4xx other than 429, which sending the same evidence
 * again would not change. `paypal_failed` is any other failure of PayPal's call: no answer, a 5xx or
 * a 429, which a later attempt may get past. For both, the cause is the error PayPal's call threw.
 */
export class SubmitEvidenceError extends Error {
  readonly code: SubmitEvidenceErrorCode;
  constructor(code: SubmitEvidenceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SubmitEvidenceError';
    this.code = code;
  }
}

/**
 * `text` on one line: every run of whitespace or line breaks becomes one space. PayPal's notes
 * pattern allows only `\n` and `\r\n` as line breaks, and NEL is a line break that `\s` misses.
 */
const oneLine = (text: string) => text.replace(/[\s\u0085]+/g, ' ').trim();

/**
 * The notes PayPal gets for the narrative, with the receipt lines when the purchase has a receipt.
 * The same text goes to the buyer when the answer is sent as a message.
 */
export function renderNotes(narrative: Narrative, receipt: { id: string; verifyUrl: string } | null): string {
  const lines = [
    oneLine(narrative.summary),
    '',
    'Claims, with the evidence items that show each:',
    ...narrative.claims.map(
      (claim, index) => `${index + 1}. ${oneLine(claim.text)} ${claim.evidenceIds.map((id) => `[${id}]`).join(' ')}`,
    ),
  ];
  if (receipt) lines.push('', `Signed receipt: ${receipt.id}`, `Verify it at: ${receipt.verifyUrl}`);
  return lines.join('\n');
}

const count = (n: number) => n.toLocaleString('en-US');

/** Whether PayPal answered that it will not take the request, rather than failing to answer it. */
const isRefusal = (failure: unknown) =>
  failure instanceof PayPalApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 429;

/**
 * Sends the narrative to PayPal as the evidence for the dispute whose row id is `disputeId`, and
 * stores it with the time from `deps.now`. The receipt's verification URL is built on
 * `deps.appUrl`, Behest's public origin. The caller has already checked that every citation names
 * an item of the dispute's evidence pack. Throws a SubmitEvidenceError, sending and storing nothing, for
 * a dispute that does not exist, is not matched to a purchase or was already submitted, and for
 * notes longer than PayPal takes. It then reads the dispute live at PayPal and stores the stage and
 * actions PayPal reports, and throws one, sending and storing nothing else, when PayPal takes no
 * evidence on it now or cannot be read. When PayPal's call throws, it logs PayPal's error, releases the
 * submission and throws one with code `paypal_refused` or `paypal_failed`. If the release fails too,
 * it throws an AggregateError of PayPal's error and the release's, and the dispute still reads as
 * submitted.
 */
export async function submitEvidence(
  deps: { db: Db; paypal: PaypalPort; now: () => Date; appUrl: string },
  i: { disputeId: string; narrative: Narrative },
): Promise<void> {
  const { db } = deps;
  const { disputeId, narrative } = i;

  const [dispute] = await db
    .select({
      paypalDisputeId: disputes.paypalDisputeId,
      purchaseId: disputes.purchaseId,
      submittedAt: disputes.submittedAt,
      receiptId: receipts.id,
    })
    .from(disputes)
    .leftJoin(receipts, eq(receipts.purchaseId, disputes.purchaseId))
    .where(eq(disputes.id, disputeId));
  if (!dispute) throw new SubmitEvidenceError('unknown_dispute', 'there is no such dispute');
  if (!dispute.purchaseId) throw new SubmitEvidenceError('unmatched', 'the dispute is not matched to a purchase');
  if (dispute.submittedAt) throw new SubmitEvidenceError('already_submitted', 'already submitted');

  const verifyUrl = new URL('/api/receipts/verify', deps.appUrl).href;
  const notes = renderNotes(narrative, dispute.receiptId ? { id: dispute.receiptId, verifyUrl } : null);
  // Refused whole: cutting the notes short could drop a claim or the receipt without anyone seeing.
  if (notes.length > MAX_NOTES_CHARS) {
    throw new SubmitEvidenceError(
      'notes_too_long',
      `The evidence notes come to ${count(notes.length)} characters, and PayPal takes at most ${count(MAX_NOTES_CHARS)}. Shorten the summary or the claims and submit again.`,
    );
  }

  const refusal = await checkAnswerAtPaypal(deps, { id: disputeId, paypalDisputeId: dispute.paypalDisputeId }, 'evidence');
  if (refusal) {
    throw new SubmitEvidenceError(refusal.code, refusal.message, 'cause' in refusal ? { cause: refusal.cause } : undefined);
  }

  const submittedAt = deps.now();
  const claimed = await db.transaction((tx) =>
    tx
      .update(disputes)
      .set({ submittedAt, narrative })
      .where(and(eq(disputes.id, disputeId), isNull(disputes.submittedAt)))
      .returning({ id: disputes.id }),
  );
  if (claimed.length === 0) throw new SubmitEvidenceError('already_submitted', 'already submitted');

  try {
    await deps.paypal.provideEvidence(dispute.paypalDisputeId, { notes });
  } catch (failure) {
    // Logged before the release, so it is on record that PayPal never took the evidence even when
    // the release fails and the dispute goes on reading as submitted.
    console.error('[disputes] PayPal did not take the evidence:', failure);
    try {
      // Only this submission's claim is released, never one recorded since.
      await db
        .update(disputes)
        .set({ submittedAt: null })
        .where(and(eq(disputes.id, disputeId), eq(disputes.submittedAt, submittedAt)));
    } catch (releaseFailure) {
      throw new AggregateError(
        [failure, releaseFailure],
        `PayPal did not take the evidence for dispute ${disputeId}, and its submission could not be released, so the dispute still reads as submitted`,
      );
    }
    if (isRefusal(failure)) throw new SubmitEvidenceError('paypal_refused', 'PayPal refused the evidence', { cause: failure });
    throw new SubmitEvidenceError('paypal_failed', 'PayPal did not take the evidence', { cause: failure });
  }
}
