import { evidenceAnchor, evidenceStyle } from '@/components/ops/evidence-style';
import { JwsView } from '@/components/ui/jws-view';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { type BadgeTone, StatusBadge } from '@/components/ui/status-badge';
import type { DraftItem } from '@/lib/ops-pages/dispute-outcomes';
import {
  decisionRecord,
  eventWords,
  logTimeline,
  type PasskeyCheckResult,
  type PasskeySignature,
  passkeySignature,
  signedArtifact,
} from '@/lib/ops-pages/evidence';
import { EvidenceText } from './evidence-text';

// The evidence items of a dispute's pack as a stack of panels, each one a citation can jump to. The
// signed mandate and receipt are decoded under their facts, a passkey's signature on the mandate and
// the decision record's hash are laid out as proof fields, and the purchase log as a timeline. Their
// text comes from Behest's records and quotes what buyers, sellers and PayPal wrote, so everything is
// shown as plain text, wrapped anywhere so a long value never widens the page.

const prose = 'text-body whitespace-pre-wrap text-text wrap-anywhere';

/** An instant as "7 Nov 2026, 13:49 UTC", as the rest of the app writes times. */
const utcMinute = (iso: string) =>
  `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(new Date(iso))} UTC`;

const CHECK_BADGES: Record<PasskeyCheckResult, { tone: BadgeTone; word: string }> = {
  verified: { tone: 'seal', word: 'Verified' },
  'not made': { tone: 'muted', word: 'Not made' },
  failed: { tone: 'stop', word: 'Failed' },
};

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The fields shown above the fold, which the full list below leaves out. */
const LEADING = new Set(['Credential id', 'Public key (COSE, base64url)', 'Passkey signature check']);

/** The passkey's signature on the mandate: the check's result, Behest's binding signature, the key, then every field. */
function PasskeyProof({ passkey }: { passkey: PasskeySignature }) {
  const { check, behestSigned, credentialId, publicKey } = passkey;
  const badge = check && CHECK_BADGES[check.result];
  const rest = passkey.fields.filter(({ label }) => !LEADING.has(label) && !label.startsWith("Behest's signature"));
  return (
    <section aria-label="The passkey signature" className="grid gap-3 rounded-control border border-line bg-bg/50 p-3 sm:p-4">
      <h4 className="text-meta font-medium text-muted">The passkey signature</h4>
      <ProofFields
        fields={[
          {
            label: 'Passkey check',
            value:
              check && badge ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone={badge.tone} label="Passkey signature check">
                    {badge.word}
                  </StatusBadge>
                  <span className="text-muted">{sentence(check.reason)}</span>
                </span>
              ) : (
                <span className="text-muted">Not stated</span>
              ),
          },
          {
            label: 'Behest signature',
            value:
              behestSigned === null ? (
                <span className="text-muted">Not stated</span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge tone={behestSigned ? 'seal' : 'stop'} label="Behest's signature on the mandate">
                    {behestSigned ? 'Verified' : 'Does not verify'}
                  </StatusBadge>
                  <span className="text-muted">It binds this passkey to the buyer&apos;s account.</span>
                </span>
              ),
          },
          {
            label: 'Credential id',
            value: credentialId ? <ProofId value={credentialId} label="Passkey credential id" /> : <span className="text-muted">Not recorded</span>,
          },
          {
            label: 'Public key',
            value: publicKey ? (
              <ProofId value={publicKey} label="Passkey public key" />
            ) : (
              <span className="text-muted">Not in the signed mandate</span>
            ),
          },
        ]}
      />
      {rest.length > 0 && (
        <details className="group">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-control text-meta font-medium text-action hover:text-action-strong [&::-webkit-details-marker]:hidden">
            Every field of the signature
            <svg viewBox="0 0 16 16" aria-hidden className="size-3 transition-transform group-open:rotate-180">
              <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </summary>
          <div className="mt-3">
            <ProofFields
              fields={rest.map(({ label, value }) => ({
                label,
                value: /\s/.test(value) ? (
                  <span className="whitespace-pre-wrap text-muted wrap-anywhere">{value}</span>
                ) : (
                  <span className="font-mono text-meta wrap-anywhere">{value}</span>
                ),
              }))}
            />
          </div>
        </details>
      )}
    </section>
  );
}

function ItemBody({ item }: { item: DraftItem }) {
  // A mandate a passkey signed ends with that signature; the signed mandate comes before it.
  const signed = item.id === 'mandate' ? passkeySignature(item.body) : null;
  const artifact = signedArtifact(signed?.text ?? item.body);
  if (artifact) {
    return (
      <div className="grid gap-3">
        {artifact.text && <EvidenceText text={artifact.text} className={prose} />}
        <JwsView jws={artifact.jws} label={item.id === 'mandate' ? 'Signed mandate' : 'Signed receipt'} decoded="folded" token="short" />
        {signed && <PasskeyProof passkey={signed.passkey} />}
      </div>
    );
  }

  const decision = item.id === 'decision' ? decisionRecord(item.body) : null;
  if (decision) {
    return (
      <div className="grid gap-3">
        {decision.text && <EvidenceText text={decision.text} className={prose} />}
        <ProofFields fields={[{ label: 'Decision record', value: <ProofId value={decision.hash} label="Decision record hash" /> }]} />
        {decision.commitment && <EvidenceText text={decision.commitment} className={`${prose} text-muted`} />}
      </div>
    );
  }

  const timeline = item.id === 'purchase_log' ? logTimeline(item.body) : null;
  if (timeline) {
    return (
      <div className="grid gap-3">
        <EvidenceText text={timeline.intro.join('\n')} className={`${prose} text-muted`} />
        <ol aria-label="Recorded steps" className="grid gap-0">
          {timeline.steps.map((step, index) => (
            <li key={step.n} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 pb-3 last:pb-0">
              {index < timeline.steps.length - 1 && <span aria-hidden className="absolute top-4 bottom-0 left-[9px] w-0.5 bg-line" />}
              <span aria-hidden className="mt-1.5 size-2.5 justify-self-center rounded-full border-2 border-[#d49cf0] bg-bg" />
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-body font-medium text-text">{eventWords(step.kind)}</span>
                  <time dateTime={step.at} title={step.at} className="font-mono text-meta text-muted tabular-nums">
                    {utcMinute(step.at)} <span className="sr-only">({step.kind})</span>
                  </time>
                </p>
                {step.detail && <EvidenceText text={step.detail.trim()} className="mt-0.5 font-mono text-meta whitespace-pre-wrap text-muted" />}
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return <EvidenceText text={item.body} className={prose} />;
}

export function EvidenceItems({ items }: { items: readonly DraftItem[] }) {
  return (
    <section data-tour="dispute-evidence" aria-labelledby="evidence-heading" className="mt-8">
      <h2 id="evidence-heading" className="text-lead font-medium text-text">
        Evidence
      </h2>
      <p className="mt-1 text-body text-muted">
        What Behest&apos;s records show, as the narrative cites them. Signed items can be decoded, and a citation jumps to its item.
      </p>
      <ul className="mt-4 grid gap-4">
        {items.map((item) => {
          const style = evidenceStyle(item.id);
          return (
            <li key={item.id}>
              <article
                id={evidenceAnchor(item.id)}
                tabIndex={-1}
                aria-labelledby={`${evidenceAnchor(item.id)}-title`}
                className="scroll-mt-28 rounded-panel border border-line bg-panel target:border-action target:ring-1 target:ring-action focus:outline-none"
              >
                <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 sm:px-5">
                  <span aria-hidden className={`size-2.5 rounded-[3px] ${style.dot}`} />
                  <h3 id={`${evidenceAnchor(item.id)}-title`} className="font-medium text-text">
                    {item.title}
                  </h3>
                  <span className="font-mono text-meta text-muted">{item.id}</span>
                </header>
                <div className="p-4 sm:p-5">
                  <ItemBody item={item} />
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
