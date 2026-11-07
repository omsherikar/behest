'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { buttonClass } from '@/components/ui/button';
import { type Draft, type DraftItem, draftOutcome, submitOutcome } from '@/lib/ops-pages/dispute-outcomes';
import { narrativeProblem, submittableNarrative, toggleCitation } from '@/lib/ops-pages/narrative-edit';
import { EvidenceItems } from './evidence-items';

// The operator drafts a dispute's narrative, edits it and submits it to PayPal. A draft is a paid
// model call, so the button says so, and a second draft asks first. The route stores the evidence
// pack but never the draft, so the narrative lives here until it is submitted. After a failed draft
// the page reloads the stored evidence items, and the operator can write the narrative from them.

type Claim = { key: number; text: string; evidenceIds: string[] };
type Narrative = { summary: string; claims: Claim[] };
type Notice = { tone: 'success' | 'danger'; text: string };

const primaryButton = buttonClass('primary');
const secondaryButton = buttonClass('secondary');
const linkButton =
  'text-sm font-semibold text-pp-blue hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60';
const textArea =
  'mt-2 w-full rounded-xl border border-line-strong bg-pp-surface p-3 text-pp-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60';
const chip = (cited: boolean) =>
  `inline-flex min-h-8 items-center rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue disabled:opacity-60 ${
    cited ? 'border-pp-blue bg-pp-blue font-semibold text-on-fill' : 'border-pp-border bg-pp-surface text-pp-ink hover:border-pp-blue'
  }`;
const NOTICE_STYLES: Record<Notice['tone'], string> = { success: 'text-pp-success', danger: 'text-pp-danger' };

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

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <p role={notice.tone === 'danger' ? 'alert' : 'status'} className={`mt-3 text-sm ${NOTICE_STYLES[notice.tone]}`}>
      {notice.text}
    </p>
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
  const [draftNotice, setDraftNotice] = useState<Notice | null>(null);
  const [submitNotice, setSubmitNotice] = useState<Notice | null>(null);

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
      <section aria-labelledby="narrative-heading" className="mt-8 rounded-xl border border-pp-border bg-pp-surface p-4 sm:p-5">
        <h2 id="narrative-heading" className="text-lg font-semibold text-pp-navy">
          Narrative
        </h2>
        <p className="mt-1 text-sm text-pp-muted">
          {items
            ? 'Edit the summary and the claims until they say only what the evidence shows. Under each claim, tap an evidence item to cite it, or tap it again to stop citing it.'
            : "No draft yet. Drafting gathers the evidence items from Behest's records, then the model writes a narrative in which every claim cites them."}
        </p>

        {confirming ? (
          <div role="group" aria-labelledby="redraft-question" className="mt-4 rounded-lg border border-pp-warning p-3">
            <p id="redraft-question" className="text-sm text-pp-ink">
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
        <p className="mt-2 text-xs text-pp-muted">
          {busy === 'draft'
            ? 'This can take a minute.'
            : 'Each draft is a model call that Behest pays for. A draft is not saved: reloading this page clears the narrative until it is submitted.'}
        </p>
        <NoticeLine notice={draftNotice} />

        {items && (
          <form onSubmit={submit} className="mt-6 border-t border-pp-border pt-5">
            <label htmlFor="narrative-summary" className="block font-semibold text-pp-navy">
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
                <li key={claim.key} className="rounded-xl border border-pp-border p-3">
                  <label htmlFor={`claim-${claim.key}`} className="block font-semibold text-pp-navy">
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
                  <p id={`claim-${claim.key}-cites`} className="mt-3 text-sm text-pp-muted">
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
                          className={chip(cited)}
                        >
                          {cited && <span aria-hidden="true">&#10003;&nbsp;</span>}
                          {item.title}
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" onClick={() => removeClaim(claim.key)} disabled={locked} className={`mt-3 ${linkButton}`}>
                    Remove claim {index + 1}
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" onClick={addClaim} disabled={locked} className={`mt-4 ${secondaryButton}`}>
              Add a claim
            </button>

            <div className="mt-6 border-t border-pp-border pt-5">
              {problem && (
                <p id="submit-problem" className="mb-3 text-sm text-pp-warning">
                  {problem}
                </p>
              )}
              <button
                type="submit"
                disabled={locked || problem !== null}
                aria-describedby={problem ? 'submit-problem' : undefined}
                className={primaryButton}
              >
                {busy === 'submit' ? 'Submitting...' : 'Submit evidence to PayPal'}
              </button>
              <p className="mt-2 text-xs text-pp-muted">
                PayPal takes one answer per dispute. Once it is submitted, this page shows it read-only.
              </p>
              <NoticeLine notice={submitNotice} />
            </div>
          </form>
        )}
      </section>

      {items && <EvidenceItems items={items} />}
    </>
  );
}
