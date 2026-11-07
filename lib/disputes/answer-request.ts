import { z } from 'zod';
import type { AnswerRefusalCode } from './answerable';
import type { Narrative } from './narrative';
import { EVIDENCE_IDS, type EvidencePack } from './pack';

// What the two routes that answer a dispute share, as evidence for PayPal or as a message to the
// buyer: the narrative the operator sends, the check that every citation names an item of the
// dispute's evidence pack, and the status of each refusal the library words for the operator itself.

/** `items` as a list in a sentence, such as `a, b and c`. */
const inProse = (items: readonly string[], conjunction: 'and' | 'or') =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;

export const NOT_JSON = 'Send the narrative as JSON.';
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
export const NarrativeRequest = z.strictObject(
  {
    summary: z.string({ error: SHAPE }).trim().min(1, { error: 'Write a summary.' }),
    claims: z.array(Claim, { error: SHAPE }).min(1, { error: 'Write at least one claim.' }),
  },
  { error: SHAPE },
);

/**
 * The status of each refusal the library words for the operator itself, with nothing PayPal sent in
 * it: an answer too long for PayPal, a dispute PayPal takes no such answer on now, and a dispute
 * PayPal could not be read to check.
 */
export const WORDED_REFUSALS: Readonly<Record<'notes_too_long' | AnswerRefusalCode, number>> = {
  notes_too_long: 400,
  inquiry: 422,
  claim: 422,
  closed: 422,
  not_taking_answers: 422,
  check_failed: 502,
};

/** Whether the library words the refusal `code` for the operator itself. */
export const isWordedRefusal = (code: string): code is keyof typeof WORDED_REFUSALS => Object.hasOwn(WORDED_REFUSALS, code);

/**
 * Why the narrative cannot be sent as it stands: the claims, numbered from 1, that cite items the
 * pack does not hold. Null when every citation names an item of the pack. Nothing the operator
 * approved is dropped on the way to PayPal, so such a narrative is refused whole.
 */
export function uncitedClaims(narrative: Narrative, pack: EvidencePack): string | null {
  const held = pack.items.map((item) => item.id);
  const uncited = narrative.claims.flatMap(({ evidenceIds }, index) => {
    const missing = evidenceIds.filter((id) => !held.includes(id));
    return missing.length > 0 ? [`claim ${index + 1} cites ${inProse(missing, 'and')}`] : [];
  });
  if (uncited.length === 0) return null;
  return `Some claims cite evidence this dispute does not have: ${uncited.join('; ')}. Its evidence is ${inProse(held, 'and')}.`;
}
