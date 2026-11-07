import { eq, sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import type { PaypalPort } from '@/lib/paypal/port';
import { type AnswerRefusalCode, checkAnswerAtPaypal, isPaypalRefusal } from './answerable';
import type { Narrative } from './narrative';
import { disputeToAnswer, MAX_NOTES_CHARS, renderNotes } from './submit';

// Sends the narrative an operator reviewed to the buyer as a message on the dispute, while PayPal
// still has it as an inquiry. PayPal takes evidence only once the inquiry becomes a claim, and until
// then a message is the answer it allows. The buyer reads exactly the text the evidence notes would
// hold, under the same limit.
//
// A message is not the dispute's one answer: the submission time stays unset, so the evidence can
// still be submitted once the case is a claim. The narrative is stored as the one to start that
// submission from, and the time of the message is recorded. The dispute is read live at PayPal first
// and nothing is sent unless PayPal allows a message now. The client keys each message on the text,
// so a retry of the same message after an answer that was lost is not sent twice.

export type SendMessageErrorCode =
  | 'unknown_dispute'
  | 'unmatched'
  | 'already_submitted'
  | 'notes_too_long'
  | AnswerRefusalCode
  | 'paypal_refused'
  | 'paypal_failed';

/**
 * Why the message was not sent. The codes of AnswerRefusalCode say PayPal takes no message on the
 * dispute now, or could not be read to check. `paypal_refused` is PayPal answering the message with
 * a 4xx other than 429, which sending it again would not change; `paypal_failed` is any other
 * failure, which a later attempt may get past. For those, the cause is the error PayPal threw.
 */
export class SendMessageError extends Error {
  readonly code: SendMessageErrorCode;
  constructor(code: SendMessageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SendMessageError';
    this.code = code;
  }
}

const count = (n: number) => n.toLocaleString('en-US');

/**
 * Sends the narrative to the buyer as a message on the dispute whose row id is `disputeId`, and
 * stores it with the time from `deps.now`, which it returns. The text is the evidence notes
 * submitEvidence would send, receipt lines included, on `deps.appUrl`. The caller has already
 * checked that every citation names an item of the dispute's evidence pack. Throws a
 * SendMessageError, sending and storing nothing, for a dispute that does not exist, is not matched to
 * a purchase or already has its evidence submitted, and for text longer than PayPal takes. It then
 * reads the dispute live at PayPal and stores the stage and actions PayPal reports, and throws one,
 * sending and storing nothing else, when PayPal takes no message on it now or cannot be read. When
 * PayPal's call throws, it logs PayPal's error and throws one with code `paypal_refused` or
 * `paypal_failed`, storing nothing.
 */
export async function sendAnswerToBuyer(
  deps: { db: Db; paypal: PaypalPort; now: () => Date; appUrl: string },
  i: { disputeId: string; narrative: Narrative },
): Promise<Date> {
  const { db } = deps;
  const { disputeId, narrative } = i;

  const dispute = await disputeToAnswer(db, disputeId);
  if (!dispute) throw new SendMessageError('unknown_dispute', 'there is no such dispute');
  if (!dispute.purchaseId) throw new SendMessageError('unmatched', 'the dispute is not matched to a purchase');
  if (dispute.submittedAt) throw new SendMessageError('already_submitted', 'already submitted');

  const message = renderNotes(narrative, dispute.receiptId, deps.appUrl);
  // Refused whole, as the evidence notes are: cutting it short could drop a claim or the receipt.
  if (message.length > MAX_NOTES_CHARS) {
    throw new SendMessageError(
      'notes_too_long',
      `The message comes to ${count(message.length)} characters, and PayPal takes at most ${count(MAX_NOTES_CHARS)}. Shorten the summary or the claims and send it again.`,
    );
  }

  const refusal = await checkAnswerAtPaypal(deps, { id: disputeId, paypalDisputeId: dispute.paypalDisputeId }, 'message');
  if (refusal) {
    throw new SendMessageError(refusal.code, refusal.message, 'cause' in refusal ? { cause: refusal.cause } : undefined);
  }

  try {
    await deps.paypal.sendDisputeMessage(dispute.paypalDisputeId, message);
  } catch (failure) {
    console.error('[disputes] PayPal did not take the message:', failure);
    if (isPaypalRefusal(failure)) throw new SendMessageError('paypal_refused', 'PayPal refused the message', { cause: failure });
    throw new SendMessageError('paypal_failed', 'PayPal did not take the message', { cause: failure });
  }

  // Recorded once PayPal has taken the message, so the time says it reached the buyer. If this
  // write fails, sending the same text again is not sent twice and records it.
  const messagedAt = deps.now();
  await db
    .update(disputes)
    .set({
      messagedAt,
      // Once evidence is submitted the column holds what PayPal was sent, which a message never replaces.
      narrative: sql`case when ${disputes.submittedAt} is null then ${JSON.stringify(narrative)}::jsonb else ${disputes.narrative} end`,
    })
    .where(eq(disputes.id, disputeId));
  return messagedAt;
}
