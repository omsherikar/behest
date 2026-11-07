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
import { eventWords, logMoments, logTimeline } from '@/lib/ops-pages/evidence';
import { requireOperator } from '../../require-operator';
import { DisputeEvidence } from './dispute-evidence';
import { EvidenceItems } from './evidence-items';

export const metadata: Metadata = {
  title: 'Dispute',
};

// One dispute, in two columns from 1024 px: the buyer's notes as they wrote them and Behest's answer
// with its evidence on the left; on the right, what PayPal reported and a timeline of the dispute and
// of the purchase behind it, from the purchase log the evidence pack records. Until evidence is
// submitted the operator drafts and edits the narrative here, and answers with it as PayPal allows:
// as evidence once the dispute is a claim, or as a message to the buyer while it is an inquiry.
// After, the page shows the narrative PayPal was sent, read-only. Everything others wrote (the
// buyer's notes, PayPal's reason, the evidence items) is shown as plain text.

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
    <>
      <Link href="/ops/disputes" className={buttonClass('quiet', 'small', '-ml-3.5 self-start')}>
        All disputes
      </Link>
      <header className="mt-3 mb-8 lg:mb-10">
        <h1 className="text-title font-medium text-text">Dispute</h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <ProofId value={dispute.paypalDisputeId} label="PayPal dispute id" full />
          <StatusBadge tone={dispute.submitted ? 'seal' : 'hold'} label="Evidence">
            {dispute.submitted ? 'Answered with evidence' : dispute.messagedAt ? 'Answered by message' : 'Not answered yet'}
          </StatusBadge>
        </div>
        <p className="mt-3 max-w-[68ch] text-lead text-pretty text-muted">
          Behest answers as the merchant of record, with evidence drawn from its signed records. Check every claim against
          the evidence before you submit.
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-12 lg:gap-x-6 xl:gap-x-8">
        <aside aria-label="What PayPal reported, and the timeline" className="grid min-w-0 content-start gap-4 lg:sticky lg:top-28 lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:self-start">
          <Facts dispute={dispute} />
          <Timeline dispute={dispute} />
        </aside>

        <div className="min-w-0 lg:col-span-8 lg:col-start-1 lg:row-start-1">
          <BuyerNotes notes={dispute.buyerNotes} />
          {dispute.submitted ? (
            <>
              <SubmittedNarrative submitted={dispute.submitted} titles={titlesOf(dispute)} />
              {dispute.items && <EvidenceItems items={dispute.items} />}
            </>
          ) : dispute.linked ? (
            <DisputeEvidence
              disputeId={dispute.id}
              items={dispute.items}
              startFrom={dispute.lastNarrative}
              actions={dispute.actions}
              messagedAt={dispute.messagedAt}
            />
          ) : (
            <Notice kind="info" className="mt-8">
              This dispute is not matched to a purchase yet, so Behest has no evidence to answer it with. Behest matches a
              dispute to a purchase by the PayPal capture it disputes.
            </Notice>
          )}
        </div>
      </div>
    </>
  );
}

type TimelineEntry = { at: string; what: string; detail?: string };

/**
 * The whole story in time order: when the purchase was proposed and captured, as the purchase log's
 * opening lines record it, every step the log recorded, worded, and the dispute's own moments:
 * opened, answered by message and answered with evidence. Before a draft gathers the evidence, the
 * purchase's side is not known here, and the timeline says so.
 */
function Timeline({ dispute }: { dispute: DisputeView }) {
  const log = dispute.items?.find((item) => item.id === 'purchase_log');
  const timeline = log ? logTimeline(log.body) : null;
  const moments = timeline ? logMoments(timeline.intro) : { createdAt: null, capturedAt: null };
  const steps = timeline?.steps ?? [];
  const logged = (kind: string) => steps.some((step) => step.kind === kind);

  const entries: TimelineEntry[] = [
    ...(moments.createdAt ? [{ at: moments.createdAt, what: 'Purchase proposed by the agent' }] : []),
    ...steps.map((step) => ({ at: step.at, what: eventWords(step.kind) })),
    // The capture time is on the purchase itself; a logged capture event already says it.
    ...(moments.capturedAt && !logged('capture') ? [{ at: moments.capturedAt, what: 'Captured at PayPal' }] : []),
    ...(dispute.openedAt ? [{ at: dispute.openedAt, what: 'Dispute opened at PayPal', detail: dispute.reason }] : []),
    ...(dispute.messagedAt ? [{ at: dispute.messagedAt, what: 'Answer sent to the buyer as a message' }] : []),
    ...(dispute.submitted ? [{ at: dispute.submitted.at, what: 'Evidence submitted to PayPal' }] : []),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <section aria-labelledby="timeline-heading" className="panel rounded-frame p-5 sm:p-6">
      <h2 id="timeline-heading" className="text-heading font-medium text-text">
        Timeline
      </h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-body text-muted">PayPal gave no time for this dispute, and no evidence has been gathered yet.</p>
      ) : (
        <ol aria-label="What happened, in order" className="mt-4 grid">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${entry.what}`} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0">
              {index < entries.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[7px] w-0.5 bg-line" />}
              <span aria-hidden className="mt-1.5 size-2.5 justify-self-center rounded-full border-2 border-muted bg-bg" />
              <div className="min-w-0">
                <p className="text-body text-text">{entry.what}</p>
                <time dateTime={entry.at} title={entry.at} className="block font-mono text-meta text-muted tabular-nums">
                  {utc(entry.at)}
                </time>
                {entry.detail && <p className="text-meta text-muted">{entry.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {!log && dispute.linked && (
        <p className="mt-4 text-meta text-muted">The purchase&apos;s own steps join this timeline once a draft gathers the evidence.</p>
      )}
    </section>
  );
}

function Facts({ dispute }: { dispute: DisputeView }) {
  return (
    <section aria-labelledby="reported-heading" className="panel rounded-frame p-5 sm:p-6">
      <h2 id="reported-heading" className="mb-4 text-heading font-medium text-text">
        What PayPal reported
      </h2>
      <ProofFields
        fields={[
          { label: 'Reason', value: dispute.reason },
          { label: 'Status at PayPal', value: dispute.status },
          // Hidden until PayPal has given a stage, so the page never shows a stage it was not told.
          ...(dispute.stage ? [{ label: 'Stage', value: dispute.stage }] : []),
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
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading" className="text-heading font-medium text-text">
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
    <section aria-labelledby="submitted-heading" className="panel mt-8 rounded-frame p-5 sm:p-6">
      <h2 id="submitted-heading" className="text-heading font-medium text-text">
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
