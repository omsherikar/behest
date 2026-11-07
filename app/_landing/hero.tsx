import { AuthorityTrace } from '@/components/ui/authority-trace';
import { buttonClass } from '@/components/ui/button';
import { JwsView } from '@/components/ui/jws-view';
import { Money } from '@/components/ui/money';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { RuleResults } from '@/components/ui/rule-results';
import { trailFromPurchase } from '@/lib/ui/trail';
import { sourceLink } from './links';
import { SAMPLE, utcMinute } from './sample';

// The top of the home page: what Behest is in one line, the two ways in, and the sample purchase's
// authority trace, which plays its five steps once and ends on the signed receipt.

function ArchitectureLink() {
  const href = sourceLink('docs/architecture.md');
  if (href) {
    return (
      <a href={href} className={buttonClass('secondary')}>
        Read the architecture
      </a>
    );
  }
  return (
    <p className="text-meta text-muted">
      Read the architecture in <code className="font-mono text-text">docs/architecture.md</code>
    </p>
  );
}

export function Hero() {
  const { receipt, mandate, receiptJws, outcomes, item, sellerName } = SAMPLE;
  const held = outcomes.find((outcome) => outcome.result === 'ask');

  return (
    <section
      aria-labelledby="hero-title"
      className="mx-auto grid w-full max-w-[1200px] gap-10 px-4 pt-10 pb-14 sm:px-6 sm:pt-16 lg:gap-12 lg:pt-20 lg:pb-20"
    >
      <div className="max-w-3xl">
        <p className="font-mono text-meta text-muted">Authority for AI agent payments on PayPal</p>
        <h1 id="hero-title" className="mt-3 max-w-[28ch] text-display font-semibold text-balance text-text">
          Signed proof of what you authorized, on every purchase your AI agent makes.
        </h1>
        <p className="mt-4 max-w-[60ch] text-lead text-pretty text-muted">
          Behest checks each purchase an agent proposes against a mandate you signed, pays through PayPal only inside it,
          and signs a receipt any seller can verify.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
          <a href="#try" className={buttonClass('primary')}>
            Try the live demo
          </a>
          <ArchitectureLink />
        </div>
      </div>

      <div className="min-w-0 rounded-panel border border-line bg-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-medium text-text">
            {item.title} <span className="font-normal text-muted">from {sellerName}</span>
          </p>
          <Money cents={receipt.cart.totalCents} className="font-medium text-text" />
        </div>
        {held?.detail && (
          <p className="mt-1 text-meta text-muted">
            Held: {held.detail.charAt(0).toLowerCase() + held.detail.slice(1)}. You approved it at PayPal, and it was paid.
          </p>
        )}
        <AuthorityTrace
          className="mt-4"
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
                  { label: 'Confirmed by', value: 'Your signed-in session' },
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
        <p className="mt-3 text-meta text-muted">A sample purchase, signed with a throwaway key. Open any step to see its proof.</p>
      </div>
    </section>
  );
}
