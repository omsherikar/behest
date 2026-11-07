// What a dispute's page tells the operator after the submit route answers. Each status the route
// can return gets its own plain words. Only a 400 carries a message meant for the operator, such as
// notes too long for PayPal or a citation of an item the dispute has no evidence for, so that is
// the only text from the route that is shown.

export type SubmitOutcome = {
  ok: boolean;
  message: string;
  /** Whether the page should reload its data: the dispute may now be submitted, or already was. */
  refresh: boolean;
};

const SUBMITTED = 'The evidence was submitted to PayPal.';
const NARRATIVE_REFUSED = 'Behest could not accept this narrative. Check the summary and claims, then submit again.';
const ALREADY_DECIDED =
  'Nothing was submitted. This dispute is not matched to a purchase, or its evidence was already submitted. The page now shows where it stands.';

const SUBMIT_FAILURES = new Map<number | null, [message: string, refresh: boolean]>([
  [
    null,
    [
      'Could not reach Behest, so the evidence may not have been submitted. Reload the page to check before you submit again.',
      false,
    ],
  ],
  [401, ['Your session has ended. Pick the operator persona on the home page, then submit again.', false]],
  [403, ['Only the operator persona can submit dispute evidence. Pick it on the home page.', false]],
  [404, ['Behest has no record of this dispute, so nothing was submitted.', false]],
  [409, [ALREADY_DECIDED, true]],
  [413, ['This narrative is too large to send. Shorten the summary or the claims, then submit again.', false]],
  [429, ['Too many requests in a short time. Wait a minute, then submit again.', false]],
  [502, ['PayPal did not take the evidence, so nothing was submitted. Submit again to retry.', false]],
]);
const SUBMIT_FAULT =
  "Something went wrong on Behest's side. The page now shows whether the evidence was submitted; check it before you submit again.";

/**
 * The outcome to show for the submit route's HTTP status and parsed JSON body. Any 2xx is success.
 * `status` is null when the request never got an answer.
 */
export function submitOutcome(status: number | null, body: unknown): SubmitOutcome {
  if (status !== null && status >= 200 && status < 300) return { ok: true, message: SUBMITTED, refresh: true };
  if (status === 400) return { ok: false, message: routeMessage(body) ?? NARRATIVE_REFUSED, refresh: false };
  const [message, refresh] = SUBMIT_FAILURES.get(status) ?? [SUBMIT_FAULT, true];
  return { ok: false, message, refresh };
}

/** The `{ error: { message } }` a route sends, as a sentence, or null when there is none. */
function routeMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? sentence(message.trim()) : null;
}

/** Text as a sentence: capitalized, with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
