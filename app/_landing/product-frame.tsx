import { AuthorityTrace } from '@/components/ui/authority-trace';
import { JwsView } from '@/components/ui/jws-view';
import { confirmationFields } from '@/components/ui/mandate-confirmation';
import { Money } from '@/components/ui/money';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { RuleResults } from '@/components/ui/rule-results';
import { StatusBadge } from '@/components/ui/status-badge';
import { PERSONA_INFO } from '@/lib/ui/personas';
import { trailFromPurchase } from '@/lib/ui/trail';
import { SAMPLE, utcMinute } from './sample';

// The product in a frame, right under the hero: the sample purchase as the buyer's purchase page
// shows it, with its authority trace, which plays its five steps once and ends open on the signed
// receipt. The frame's top bar is a picture of the app's own bar, so it is hidden from screen
// readers and cannot be focused; everything below it is the real, interactive trace.

const BUYER_PAGES = PERSONA_INFO.find((info) => info.persona === 'buyer')?.nav ?? [];

function FrameBar() {
  return (
    <div aria-hidden inert className="flex h-12 items-center gap-4 border-b border-line bg-white/[0.02] px-4 sm:h-14 sm:px-5">
      <span className="font-mono text-[0.9375rem] font-semibold tracking-[-0.03em] text-text">behest</span>
      <span className="hidden h-5 w-px bg-line sm:block" />
      <span className="hidden items-center gap-1 sm:flex">
        {BUYER_PAGES.map(({ label }) => (
          <span
            key={label}
            className={`rounded-full px-3 py-1 text-meta font-medium ${label === 'Ledger' ? 'bg-white/[0.08] text-text' : 'text-muted'}`}
          >
            {label}
          </span>
        ))}
      </span>
      <span className="ml-auto rounded-full border border-line px-3 py-1 text-meta text-muted">Viewing as Buyer</span>
    </div>
  );
}

export function ProductFrame() {
  const { receipt, mandate, receiptJws, outcomes, item, sellerName } = SAMPLE;
  const held = outcomes.find((outcome) => outcome.result === 'ask');

  return (
    <div className="container-page">
      <figure>
        <div className="overflow-hidden rounded-frame border border-line-strong bg-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <FrameBar />
          <div className="p-5 sm:p-8 lg:p-10">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <p className="text-meta text-muted">Purchase from {sellerName}</p>
                <p className="mt-1 text-heading font-medium text-text">{item.title}</p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge tone="seal" label="Status">
                  Paid
                </StatusBadge>
                <Money cents={receipt.cart.totalCents} className="text-heading font-medium text-text" />
              </div>
            </div>
            {held?.detail && (
              <p className="mt-3 max-w-[70ch] text-body text-muted">
                Held because {held.detail.charAt(0).toLowerCase() + held.detail.slice(1)}. You approved it at PayPal, and it
                was paid.
              </p>
            )}
            <AuthorityTrace
              className="mt-8"
              label="Authority trace of the sample purchase"
              states={trailFromPurchase('captured', receipt.decision.verdict, receipt.decision.verdict, true)}
              play
              defaultOpen="receipt"
              proof={{
                mandate: (
                  <ProofFields
                    fields={[
                      { label: 'Mandate id', value: <ProofId value={mandate.id} label="Mandate id" /> },
                      { label: 'Policy hash', value: <ProofId value={mandate.policyHash} label="Policy hash" /> },
                      { label: 'Signed at', value: <span className="font-mono text-meta">{utcMinute(mandate.confirmedAt)}</span> },
                      ...confirmationFields(mandate.confirmation, mandate.confirmation === 'passkey' ? mandate.passkey.credentialId : null),
                    ]}
                  />
                ),
                gate: <RuleResults results={outcomes} />,
                intent: (
                  <p className="text-body text-muted">
                    The intent check compares the cart with the request and can only tighten the gate&apos;s verdict. Here it
                    left the verdict as the gate set it: ask you.
                  </p>
                ),
                paypal: (
                  <ProofFields
                    fields={[
                      { label: 'Order id', value: <ProofId value={receipt.payment.orderId} label="PayPal order id" /> },
                      { label: 'Capture id', value: <ProofId value={receipt.payment.captureId} label="PayPal capture id" /> },
                      { label: 'Captured at', value: <span className="font-mono text-meta">{utcMinute(receipt.payment.capturedAt)}</span> },
                      { label: 'Approved by', value: 'You, at PayPal' },
                    ]}
                  />
                ),
                receipt: <JwsView jws={receiptJws} decoded="folded" token="short" />,
              }}
            />
          </div>
        </div>
        <figcaption className="mt-4 text-center text-meta text-muted">
          A sample purchase, signed with a throwaway key. Open any step to see its proof.
        </figcaption>
      </figure>
    </div>
  );
}
