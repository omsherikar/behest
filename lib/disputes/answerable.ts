import { eq } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { disputes } from '@/lib/db/schema';
import { PayPalApiError } from '@/lib/paypal/http';
import type { DisputeDetail, PaypalPort } from '@/lib/paypal/port';

// Whether PayPal takes Behest's answer to a dispute right now. PayPal offers each answer only through
// a link on the dispute: provide_evidence once the case is a claim, send_message while it is an
// inquiry, and neither while PayPal reviews the case or once it is closed. Asked for an answer it
// does not offer, PayPal refuses with ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE, so Behest reads the
// dispute live before it sends anything and refuses in plain words instead. What PayPal reported is
// stored on the dispute either way, so the page offers what PayPal allows from then on.

/** The two ways Behest answers a dispute: evidence for PayPal, or a message to the buyer. */
export type Answer = 'evidence' | 'message';

/** Why an answer was not sent: the dispute's state at PayPal does not allow it, or PayPal could not be read. */
export type AnswerRefusalCode = 'inquiry' | 'claim' | 'closed' | 'not_taking_answers' | 'check_failed';

export type AnswerRefusal = { code: AnswerRefusalCode; message: string; cause?: unknown };

/** PayPal's status for a dispute it has closed. */
export const CLOSED_STATUS = 'RESOLVED';

/** The link rel through which PayPal offers each answer. */
const ACTION: Record<Answer, string> = { evidence: 'provide_evidence', message: 'send_message' };

const CHECK_FAILED = 'Could not check the dispute at PayPal. Try again.';

/**
 * Whether PayPal answered a request with a 4xx other than 429: it will not take it, and sending the
 * same again would not change that. Any other failure (no answer, a 5xx or a 429) a later attempt
 * may get past.
 */
export const isPaypalRefusal = (failure: unknown) =>
  failure instanceof PayPalApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 429;

/**
 * Why PayPal would not take `answer` on the dispute as PayPal reported it, in words for the
 * operator, or null when PayPal would take it.
 */
export function answerRefusal(dispute: Pick<DisputeDetail, 'status' | 'actions'>, answer: Answer): AnswerRefusal | null {
  if (dispute.status === CLOSED_STATUS) {
    return { code: 'closed', message: 'PayPal has closed this dispute, so it takes no answer from Behest.' };
  }
  if (dispute.actions.includes(ACTION[answer])) return null;
  if (answer === 'evidence' && dispute.actions.includes(ACTION.message)) {
    return {
      code: 'inquiry',
      message: 'PayPal takes evidence once this inquiry becomes a claim. Until then, send the buyer your answer as a message.',
    };
  }
  if (answer === 'message' && dispute.actions.includes(ACTION.evidence)) {
    return { code: 'claim', message: 'PayPal takes evidence on this dispute now, not a message. Submit the evidence to PayPal instead.' };
  }
  return {
    code: 'not_taking_answers',
    message:
      dispute.actions.length === 0
        ? 'PayPal is reviewing this dispute and takes no answer from Behest right now.'
        : 'PayPal takes no evidence or message from Behest on this dispute right now.',
  };
}

/**
 * Reads the dispute live at PayPal and stores the stage and actions PayPal reports on its row
 * `dispute.id`. Returns why PayPal would not take `answer` now, or null when it would. When PayPal
 * cannot be read, it logs PayPal's error and returns `check_failed` with that error as the cause,
 * storing nothing: an answer is never sent without this check.
 */
export async function checkAnswerAtPaypal(
  deps: { db: Db; paypal: PaypalPort },
  dispute: { id: string; paypalDisputeId: string },
  answer: Answer,
): Promise<AnswerRefusal | null> {
  let live: DisputeDetail;
  try {
    live = await deps.paypal.getDispute(dispute.paypalDisputeId);
  } catch (failure) {
    console.error('[disputes] PayPal did not return the dispute:', failure);
    return { code: 'check_failed', message: CHECK_FAILED, cause: failure };
  }
  await deps.db.update(disputes).set({ stage: live.stage, actions: live.actions }).where(eq(disputes.id, dispute.id));
  return answerRefusal(live, answer);
}
