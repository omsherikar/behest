import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { CitationChip } from '@/components/ops/evidence-style';
import { buttonClass } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { StatusBadge } from '@/components/ui/status-badge';
import { disputeView, type DisputeView } from '@/lib/ops-pages/disputes';
import { requireOperator } from '../../require-operator';
import { DisputeEvidence } from './dispute-evidence';
import { EvidenceItems } from './evidence-items';

export const metadata: Metadata = {
  title: 'Dispute',
};

// One dispute: what PayPal reported, the buyer's notes as they wrote them, and Behest's answer.
// Until evidence is submitted the operator drafts, edits and submits the narrative here; after,
// the page shows the narrative PayPal was sent, read-only. Everything others wrote (the buyer's
// notes, PayPal's reason, the evidence items) is shown as plain text.

// 7 Nov 2026, 09:00.
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const utc = (iso: string) => `${dateTime.format(new Date(iso))} UTC`;

export default async function DisputePage({ params }: PageProps<'/ops/disputes/[id]'>) {
  // Reads the database on every request, never at build time.
  await connection();
  await requireOperator();

  const { id } = await params;
  const dispute = await disputeView(appDb(), id);
  if (!dispute) notFound();

  return (
    <div className="w-full max-w-3xl">
      <Link href="/ops/disputes" className={buttonClass('quiet', 'small', '-ml-2.5')}>
        All disputes
      </Link>
      <header className="mt-3 mb-6">
        <h1 className="text-title font-semibold text-text">Dispute</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ProofId value={dispute.paypalDisputeId} label="PayPal dispute id" full />
          <StatusBadge tone={dispute.submitted ? 'seal' : 'hold'} label="Evidence">
            {dispute.submitted ? 'Answered with evidence' : 'Not answered yet'}
          </StatusBadge>
        </div>
        <p className="mt-2 max-w-[75ch] text-body text-muted">
          Behest answers as the merchant of record, with evidence drawn from its signed records. Check every claim against
          the evidence before you submit.
        </p>
      </header>
      <Facts dispute={dispute} />
      <BuyerNotes notes={dispute.buyerNotes} />

      {dispute.submitted ? (
        <>
          <SubmittedNarrative submitted={dispute.submitted} titles={titlesOf(dispute)} />
          {dispute.items && <EvidenceItems items={dispute.items} />}
        </>
      ) : dispute.linked ? (
        <DisputeEvidence disputeId={dispute.id} items={dispute.items} startFrom={dispute.lastNarrative} />
      ) : (
        <Notice kind="info" className="mt-8">
          This dispute is not matched to a purchase yet, so Behest has no evidence to answer it with. Behest matches a
          dispute to a purchase by the PayPal capture it disputes.
        </Notice>
      )}
    </div>
  );
}

function Facts({ dispute }: { dispute: DisputeView }) {
  return (
    <section aria-label="What PayPal reported" className="rounded-panel border border-line bg-panel p-4 sm:p-5">
      <ProofFields
        fields={[
          { label: 'Reason', value: dispute.reason },
          { label: 'Status at PayPal', value: dispute.status },
          { label: 'Amount', value: <Money cents={dispute.amountCents} mono /> },
          { label: 'Opened', value: dispute.openedAt ? <span className="font-mono text-meta">{utc(dispute.openedAt)}</span> : 'Not recorded' },
          { label: 'Purchase', value: dispute.linked ? 'Matched' : 'Not matched' },
        ]}
      />
    </section>
  );
}

function BuyerNotes({ notes }: { notes: string | null }) {
  return (
    <section aria-labelledby="notes-heading" className="mt-8">
      <h2 id="notes-heading" className="text-lead font-medium text-text">
        The buyer&apos;s notes
      </h2>
      {notes ? (
        <>
          <p className="mt-1 text-body text-muted">As PayPal passed them on. Weigh them against the evidence.</p>
          <blockquote className="mt-3 border-l-2 border-line-strong pl-3 text-body whitespace-pre-wrap text-text wrap-anywhere">
            {notes}
          </blockquote>
        </>
      ) : (
        <p className="mt-1 text-body text-muted">The buyer wrote no notes at PayPal.</p>
      )}
    </section>
  );
}

/** The title of each evidence item by id, for naming what a submitted claim cites. */
function titlesOf(dispute: DisputeView): Map<string, string> {
  return new Map((dispute.items ?? []).map((item) => [item.id, item.title]));
}

function SubmittedNarrative({
  submitted,
  titles,
}: {
  submitted: NonNullable<DisputeView['submitted']>;
  titles: Map<string, string>;
}) {
  const { narrative } = submitted;
  return (
    <section aria-labelledby="submitted-heading" className="mt-8 rounded-panel border border-line bg-panel p-4 sm:p-5">
      <h2 id="submitted-heading" className="text-lead font-medium text-text">
        Submitted narrative
      </h2>
      <Notice kind="success" className="mt-3">
        Sent to PayPal on {utc(submitted.at)}. It can no longer be changed.
      </Notice>
      {narrative ? (
        <>
          <h3 className="mt-5 font-medium text-text">Summary</h3>
          <p className="mt-1 text-body whitespace-pre-wrap text-text wrap-anywhere">{narrative.summary}</p>
          <h3 className="mt-5 font-medium text-text">Claims</h3>
          <ol className="mt-2 flex list-decimal flex-col gap-4 pl-5 marker:font-mono marker:text-meta marker:text-muted">
            {narrative.claims.map((claim, index) => (
              <li key={index}>
                <p className="text-body whitespace-pre-wrap text-text wrap-anywhere">{claim.text}</p>
                <ul aria-label={`Evidence cited by claim ${index + 1}`} className="mt-2 flex flex-wrap gap-2">
                  {claim.evidenceIds.map((evidenceId) => (
                    <li key={evidenceId}>
                      <CitationChip id={evidenceId} title={titles.get(evidenceId) ?? evidenceId} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-3 text-body text-muted">No narrative was recorded with the submission.</p>
      )}
    </section>
  );
}
