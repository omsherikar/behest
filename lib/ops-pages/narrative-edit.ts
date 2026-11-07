// The narrative the operator edits on a dispute's page before submitting it: a summary, and claims
// that each cite items of the dispute's evidence pack by id. The submit route keeps only citations
// of items the pack holds and leaves out a claim citing none, so the page checks the same before it
// sends anything, rather than letting a claim go missing without the operator seeing.

export type EditableClaim = { text: string; evidenceIds: readonly string[] };
export type EditableNarrative = { summary: string; claims: readonly EditableClaim[] };

/** A narrative in the shape the submit route takes. */
export type SubmittedNarrative = { summary: string; claims: { text: string; evidenceIds: string[] }[] };

/** `ids` without repeats or ids the pack does not hold, in the order the pack lists its items. */
function inPackOrder(ids: Iterable<string>, packIds: readonly string[]): string[] {
  const kept = new Set(ids);
  return packIds.filter((id) => kept.has(id));
}

/**
 * `cited` with `id` added, or removed when it is already there, in the order the pack lists its
 * items. An id the pack does not hold is never added, and any already cited is dropped.
 */
export function toggleCitation(cited: readonly string[], id: string, packIds: readonly string[]): string[] {
  const next = new Set(cited);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return inPackOrder(next, packIds);
}

/** Why the narrative cannot be submitted as it stands, in words for the operator, or null when it can. */
export function narrativeProblem(narrative: EditableNarrative, packIds: readonly string[]): string | null {
  if (narrative.summary.trim() === '') return 'Write a summary before you submit.';
  if (narrative.claims.length === 0) return 'Add at least one claim before you submit.';
  for (const [index, claim] of narrative.claims.entries()) {
    if (claim.text.trim() === '') return `Claim ${index + 1} has no text. Write it or remove the claim.`;
    if (inPackOrder(claim.evidenceIds, packIds).length === 0) {
      return `Claim ${index + 1} cites no evidence item. Choose at least one, or remove the claim.`;
    }
  }
  return null;
}

/** The body to submit: trimmed text, and each claim's citations of items the pack holds, in pack order. */
export function submittableNarrative(narrative: EditableNarrative, packIds: readonly string[]): SubmittedNarrative {
  return {
    summary: narrative.summary.trim(),
    claims: narrative.claims.map((claim) => ({
      text: claim.text.trim(),
      evidenceIds: inPackOrder(claim.evidenceIds, packIds),
    })),
  };
}
