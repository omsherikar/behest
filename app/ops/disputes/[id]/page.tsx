import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { formatUsd } from '@/lib/domain/money';
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

const backLink =
  'text-sm font-semibold text-pp-blue hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';

export default async function DisputePage({ params }: PageProps<'/ops/disputes/[id]'>) {
  // Reads the database on every request, never at build time.
  await connection();
  await requireOperator();

  const { id } = await params;
  const dispute = await disputeView(appDb(), id);
  if (!dispute) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 font-paypal text-pp-ink sm:py-10">
      <Link href="/ops/disputes" className={backLink}>
        All disputes
      </Link>
      <h1 className="mt-4 text-[28px] font-semibold break-words text-pp-navy">
        Dispute <span className="font-mono text-2xl">{dispute.paypalDisputeId}</span>
      </h1>
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
        <p className="mt-8 rounded-xl border border-pp-border bg-pp-surface p-4 text-sm text-pp-muted">
          This dispute is not matched to a purchase yet, so Behest has no evidence to answer it with. Behest matches a
          dispute to a purchase by the PayPal capture it disputes.
        </p>
      )}
    </main>
  );
}

function Facts({ dispute }: { dispute: DisputeView }) {
  const facts: [label: string, value: string][] = [
    ['Reason', dispute.reason],
    ['Status at PayPal', dispute.status],
    ['Amount', formatUsd(dispute.amountCents)],
    ['Opened', dispute.openedAt ? utc(dispute.openedAt) : 'Not recorded'],
    ['Purchase', dispute.linked ? 'Matched' : 'Not matched'],
    ['Evidence', dispute.submitted ? 'Submitted' : 'Not submitted'],
  ];
  return (
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-pp-border bg-pp-surface p-4 sm:grid-cols-3 sm:p-5">
      {facts.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-sm text-pp-muted">{label}</dt>
          <dd className="font-semibold break-words text-pp-navy">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BuyerNotes({ notes }: { notes: string | null }) {
  return (
    <section aria-labelledby="notes-heading" className="mt-8">
      <h2 id="notes-heading" className="text-lg font-semibold text-pp-navy">
        The buyer&apos;s notes
      </h2>
      {notes ? (
        <>
          <p className="mt-1 text-sm text-pp-muted">As PayPal passed them on. Weigh them against the evidence.</p>
          <blockquote className="mt-3 border-l-4 border-pp-border pl-3 whitespace-pre-wrap text-pp-ink wrap-anywhere">
            {notes}
          </blockquote>
        </>
      ) : (
        <p className="mt-1 text-sm text-pp-muted">The buyer wrote no notes at PayPal.</p>
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
    <section aria-labelledby="submitted-heading" className="mt-8 rounded-xl border border-pp-border bg-pp-surface p-4 sm:p-5">
      <h2 id="submitted-heading" className="text-lg font-semibold text-pp-navy">
        Submitted narrative
      </h2>
      <p className="mt-1 text-sm text-pp-muted">Sent to PayPal on {utc(submitted.at)}. It can no longer be changed.</p>
      {narrative ? (
        <>
          <h3 className="mt-5 font-semibold text-pp-navy">Summary</h3>
          <p className="mt-1 whitespace-pre-wrap wrap-anywhere">{narrative.summary}</p>
          <h3 className="mt-5 font-semibold text-pp-navy">Claims</h3>
          <ol className="mt-2 flex list-decimal flex-col gap-3 pl-5">
            {narrative.claims.map((claim, index) => (
              <li key={index}>
                <p className="whitespace-pre-wrap wrap-anywhere">{claim.text}</p>
                <ul aria-label={`Evidence cited by claim ${index + 1}`} className="mt-2 flex flex-wrap gap-2">
                  {claim.evidenceIds.map((evidenceId) => (
                    <li key={evidenceId} className="rounded-full bg-pp-highlight px-3 py-1 text-sm text-pp-blue-dark">
                      {titles.get(evidenceId) ?? evidenceId}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-3 text-sm text-pp-muted">No narrative was recorded with the submission.</p>
      )}
    </section>
  );
}
