// What a dispute's page tells the operator after the draft or submit route answers. Each status a
// route can return gets its own plain words. Only two answers carry a message meant for the
// operator, so only their text from the route is shown: the submit route's 400, such as notes too
// long for PayPal or a citation of an item the dispute has no evidence for, and the draft route's
// 502, a fixed message naming why the model or PayPal made no draft.

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

/** An evidence item of a draft's pack, as the page shows it. */
export type DraftItem = { id: string; title: string; body: string };
/** What a draft gives the page: the items of the pack it was drafted from, and the narrative. */
export type Draft = { items: DraftItem[]; narrative: { summary: string; claims: { text: string; evidenceIds: string[] }[] } };

export type DraftOutcome = { ok: true; draft: Draft } | { ok: false; message: string; refresh: boolean };

const DRAFT_UNREADABLE = 'Behest sent a draft this page could not read. Reload the page, then draft again.';
const DRAFT_FAILED = 'The draft failed. Write the narrative yourself, or draft again in a minute.';

const DRAFT_FAILURES = new Map<number | null, [message: string, refresh: boolean]>([
  [null, ['Could not reach Behest. Check your connection, then draft again.', false]],
  [401, ['Your session has ended. Pick the operator persona on the home page, then draft again.', false]],
  [403, ['Only the operator persona can draft dispute evidence. Pick it on the home page.', false]],
  [404, ['Behest has no record of this dispute, so nothing was drafted.', false]],
  [
    409,
    [
      'Nothing was drafted. This dispute is not matched to a purchase, or its evidence was already submitted. The page now shows where it stands.',
      true,
    ],
  ],
  [429, ['Too many drafts in a short time. Wait a minute, then draft again.', false]],
]);
const DRAFT_FAULT = "Something went wrong on Behest's side, so no draft came back. Draft again in a minute.";

/**
 * The outcome to show for the draft route's HTTP status and parsed JSON body. Any 2xx is success
 * when its body holds a pack and a narrative. `status` is null when the request never got an answer.
 */
export function draftOutcome(status: number | null, body: unknown): DraftOutcome {
  if (status !== null && status >= 200 && status < 300) {
    const draft = readDraft(body);
    return draft ? { ok: true, draft } : { ok: false, message: DRAFT_UNREADABLE, refresh: true };
  }
  // The route stores the pack before it asks PayPal or the model, so after a failed draft a reload
  // shows the evidence items the operator can write the narrative from.
  if (status === 502) return { ok: false, message: routeMessage(body) ?? DRAFT_FAILED, refresh: true };
  const [message, refresh] = DRAFT_FAILURES.get(status) ?? [DRAFT_FAULT, true];
  return { ok: false, message, refresh };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isPresent = <T>(value: T | null): value is T => value !== null;

/** The pack's items and the narrative in a draft route's body, with no other fields, or null when it holds none. */
function readDraft(body: unknown): Draft | null {
  if (!isRecord(body) || !isRecord(body.pack) || !isRecord(body.narrative)) return null;
  const { items } = body.pack;
  const { summary, claims } = body.narrative;
  if (!Array.isArray(items) || !isText(summary) || !Array.isArray(claims)) return null;
  const readItems = items.map((item: unknown) =>
    isRecord(item) && isText(item.id) && isText(item.title) && isText(item.body)
      ? { id: item.id, title: item.title, body: item.body }
      : null,
  );
  const readClaims = claims.map((claim: unknown) =>
    isRecord(claim) && isText(claim.text) && Array.isArray(claim.evidenceIds) && claim.evidenceIds.every(isText)
      ? { text: claim.text, evidenceIds: [...claim.evidenceIds] }
      : null,
  );
  if (!readItems.every(isPresent) || !readClaims.every(isPresent)) return null;
  return { items: readItems, narrative: { summary, claims: readClaims } };
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
