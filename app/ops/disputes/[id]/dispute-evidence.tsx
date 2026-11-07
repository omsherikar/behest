'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { CitationChip, evidenceStyle } from '@/components/ops/evidence-style';
import { buttonClass } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { type Draft, type DraftItem, draftOutcome, submitOutcome } from '@/lib/ops-pages/dispute-outcomes';
import { narrativeProblem, submittableNarrative, toggleCitation } from '@/lib/ops-pages/narrative-edit';
import { EvidenceItems } from './evidence-items';

// The operator drafts a dispute's narrative, edits it and submits it to PayPal. A draft is a paid
// model call, so the button says so, and a second draft asks first. The route stores the evidence
// pack but never the draft, so the narrative lives here until it is submitted. After a failed draft
// the page reloads the stored evidence items, and the operator can write the narrative from them.

type Claim = { key: number; text: string; evidenceIds: string[] };
type Narrative = { summary: string; claims: Claim[] };
type Outcome = { tone: 'success' | 'danger'; text: string };

const primaryButton = buttonClass('primary');
const secondaryButton = buttonClass('secondary');
const linkButton = 'text-meta font-medium text-action hover:text-action-strong hover:underline disabled:opacity-60';
const textArea = 'mt-2 w-full rounded-control border border-line-strong bg-bg p-3 text-body text-text disabled:opacity-60';
/** A toggle that cites an evidence item, in the item's colour once it is cited. */
const chip = (cited: boolean, id: string) =>
  `inline-flex min-h-8 items-center gap-1.5 rounded-control border px-2.5 text-body transition-colors disabled:opacity-60 ${
    cited ? `${evidenceStyle(id).chip} text-text` : 'border-line-strong bg-panel text-muted hover:bg-raised hover:text-text'
  }`;

/** A narrative as the editor holds it, each claim keyed by its position. */
function editable(narrative: Draft['narrative']): Narrative {
  return {
    summary: narrative.summary,
    claims: narrative.claims.map((claim, key) => ({ key, text: claim.text, evidenceIds: [...claim.evidenceIds] })),
  };
}

/** POSTs to a route and returns its status and parsed JSON body; the status is null when nothing came back. */
async function post(url: string, body?: unknown): Promise<{ status: number | null; body: unknown }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      ...(body !== undefined && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: null, body: null };
  }
}

function OutcomeNotice({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <Notice kind={outcome.tone === 'danger' ? 'stop' : 'success'} className="mt-3">
      {outcome.text}
    </Notice>
  );
}

export function DisputeEvidence({
  disputeId,
  items: storedItems,
  startFrom,
}: {
  disputeId: string;
  /** The evidence items of the pack the last draft stored, or null before any draft. */
  items: DraftItem[] | null;
  /** A narrative to start editing from, such as one PayPal did not take, or null. */
  startFrom: Draft['narrative'] | null;
}) {
  const router = useRouter();
  /** The items of a draft made on this page, which replace the stored ones until the page reloads them. */
  const [draftedItems, setDraftedItems] = useState<DraftItem[] | null>(null);
  const [narrative, setNarrative] = useState<Narrative>(() => editable(startFrom ?? { summary: '', claims: [] }));
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [draftNotice, setDraftNotice] = useState<Outcome | null>(null);
  const [submitNotice, setSubmitNotice] = useState<Outcome | null>(null);

  const items = draftedItems ?? storedItems;
  const packIds = items?.map((item) => item.id) ?? [];
  const problem = narrativeProblem(narrative, packIds);

  async function draft() {
    setConfirming(false);
    setBusy('draft');
    setDraftNotice(null);
    setSubmitNotice(null);
    const answer = await post(`/api/disputes/${disputeId}/draft`);
    const outcome = draftOutcome(answer.status, answer.body);
    if (outcome.ok) {
      setDraftedItems(outcome.draft.items);
      setNarrative(editable(outcome.draft.narrative));
      setDraftNotice({ tone: 'success', text: 'Here is the draft. Check every claim against the evidence items before you submit.' });
    } else {
      setDraftNotice({ tone: 'danger', text: outcome.message });
      if (outcome.refresh) {
        // The stored evidence items take over again, as the reload brings them.
        setDraftedItems(null);
        router.refresh();
      }
    }
    setBusy(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (problem !== null) return;
    setBusy('submit');
    setSubmitNotice(null);
    const answer = await post(`/api/disputes/${disputeId}/evidence`, submittableNarrative(narrative, packIds));
    const outcome = submitOutcome(answer.status, answer.body);
    setSubmitNotice({ tone: outcome.ok ? 'success' : 'danger', text: outcome.message });
    // After a submission the page reloads to show it read-only in place of this form.
    if (outcome.refresh) router.refresh();
    setBusy(null);
  }

  function editClaim(key: number, change: (claim: Claim) => Claim) {
    setNarrative((current) => ({
      ...current,
      claims: current.claims.map((claim) => (claim.key === key ? change(claim) : claim)),
    }));
  }

  function addClaim() {
    setNarrative((current) => {
      const key = Math.max(-1, ...current.claims.map((claim) => claim.key)) + 1;
      return { ...current, claims: [...current.claims, { key, text: '', evidenceIds: [] }] };
    });
  }

  function removeClaim(key: number) {
    setNarrative((current) => ({ ...current, claims: current.claims.filter((claim) => claim.key !== key) }));
  }

  const locked = busy !== null;

  return (
    <>
      <section aria-labelledby="narrative-heading" className="mt-8 rounded-panel border border-line bg-panel p-4 sm:p-5">
        <h2 id="narrative-heading" className="text-lead font-medium text-text">
          Narrative
        </h2>
        <p className="mt-1 text-body text-muted">
          {items
            ? 'Edit the summary and the claims until they say only what the evidence shows. Under each claim, tap an evidence item to cite it, or tap it again to stop citing it.'
            : "No draft yet. Drafting gathers the evidence items from Behest's records, then the model writes a narrative in which every claim cites them."}
        </p>

        {confirming ? (
          <div role="group" aria-labelledby="redraft-question" className="mt-4 rounded-panel border border-hold/35 bg-hold/12 p-4">
            <p id="redraft-question" className="text-body text-text">
              Drafting again is another paid model call, and its narrative replaces the one below, with your edits.
              Draft again?
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" onClick={() => void draft()} className={primaryButton}>
                Yes, draft again
              </button>
              <button type="button" onClick={() => setConfirming(false)} className={secondaryButton}>
                Keep this narrative
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => (items ? setConfirming(true) : void draft())}
            disabled={locked}
            className={`mt-4 ${items ? secondaryButton : primaryButton}`}
          >
            {busy === 'draft' ? 'Drafting...' : items ? 'Draft again (another model call)' : 'Draft the narrative (one model call)'}
          </button>
        )}
        <p className="mt-2 text-meta text-muted">
          {busy === 'draft'
            ? 'This can take a minute.'
            : 'Each draft is a model call that Behest pays for. A draft is not saved: reloading this page clears the narrative until it is submitted.'}
        </p>
        <OutcomeNotice outcome={draftNotice} />

        {items && (
          <form onSubmit={submit} className="mt-6 border-t border-line pt-5">
            <label htmlFor="narrative-summary" className="block font-medium text-text">
              Summary
            </label>
            <textarea
              id="narrative-summary"
              value={narrative.summary}
              onChange={(event) => setNarrative({ ...narrative, summary: event.target.value })}
              disabled={locked}
              rows={4}
              className={textArea}
            />

            <ol className="mt-5 flex flex-col gap-4">
              {narrative.claims.map((claim, index) => (
                <li key={claim.key} className="rounded-panel border border-line bg-bg/40 p-3 sm:p-4">
                  <label htmlFor={`claim-${claim.key}`} className="block font-medium text-text">
                    Claim {index + 1}
                  </label>
                  <textarea
                    id={`claim-${claim.key}`}
                    value={claim.text}
                    onChange={(event) => editClaim(claim.key, (c) => ({ ...c, text: event.target.value }))}
                    disabled={locked}
                    rows={3}
                    className={textArea}
                  />
                  <p id={`claim-${claim.key}-cites`} className="mt-3 text-meta text-muted">
                    Evidence cited by claim {index + 1}
                  </p>
                  <div role="group" aria-labelledby={`claim-${claim.key}-cites`} className="mt-2 flex flex-wrap gap-2">
                    {items.map((item) => {
                      const cited = claim.evidenceIds.includes(item.id);
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-pressed={cited}
                          onClick={() =>
                            editClaim(claim.key, (c) => ({ ...c, evidenceIds: toggleCitation(c.evidenceIds, item.id, packIds) }))
                          }
                          disabled={locked}
                          className={chip(cited, item.id)}
                        >
                          <span aria-hidden className={`size-2 rounded-[2px] ${evidenceStyle(item.id).dot}`} />
                          {cited && <span aria-hidden="true">&#10003;</span>}
                          {item.title}
                        </button>
                      );
                    })}
                  </div>
                  {claim.evidenceIds.length > 0 && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-meta text-muted">Read the cited evidence:</span>
                      {claim.evidenceIds.map((id) => (
                        <CitationChip key={id} id={id} title={items.find((item) => item.id === id)?.title ?? id} />
                      ))}
                    </div>
                  )}
                  <button type="button" onClick={() => removeClaim(claim.key)} disabled={locked} className={`mt-3 ${linkButton}`}>
                    Remove claim {index + 1}
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" onClick={addClaim} disabled={locked} className={`mt-4 ${secondaryButton}`}>
              Add a claim
            </button>

            <div className="mt-6 border-t border-line pt-5">
              {problem && (
                <div id="submit-problem" className="mb-3">
                  <Notice kind="hold">{problem}</Notice>
                </div>
              )}
              <button
                type="submit"
                disabled={locked || problem !== null}
                aria-describedby={problem ? 'submit-problem' : undefined}
                className={primaryButton}
              >
                {busy === 'submit' ? 'Submitting...' : 'Submit evidence to PayPal'}
              </button>
              <p className="mt-2 text-meta text-muted">
                PayPal takes one answer per dispute. Once it is submitted, this page shows it read-only.
              </p>
              <OutcomeNotice outcome={submitNotice} />
            </div>
          </form>
        )}
      </section>

      {items && <EvidenceItems items={items} />}
    </>
  );
}
