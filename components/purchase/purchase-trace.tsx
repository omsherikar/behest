'use client';

import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { AuthorityTrace, type TraceProof } from '@/components/ui/authority-trace';
import { buttonClass } from '@/components/ui/button';
import { JwsView } from '@/components/ui/jws-view';
import { ProofFields } from '@/components/ui/proof-fields';
import { ProofId } from '@/components/ui/proof-id';
import { RuleResults } from '@/components/ui/rule-results';
import { VerifyReceipt } from '@/components/ui/verify-receipt';
import type { TraceStep } from '@/lib/ui/trail';

// One purchase's authority trace with the proof behind every step it reached: the signed mandate,
// each gate rule, the intent check, the PayPal ids and the signed receipt, which can be verified
// from here. A step the purchase never reached has nothing to open.

const INTENT_WORDS: Record<NonNullable<PurchaseDetail['intent']>['verdict'], string> = {
  consistent: 'Consistent: the cart matches your request.',
  needs_human: 'Unsure whether the cart matches your request, so it asked you.',
  inconsistent: 'The cart does not match your request, so it was blocked.',
  unavailable: 'The check could not run, so it asked you.',
};

/** A UTC time as "2026-11-07 14:02 UTC". */
const utcMinute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const Time = ({ iso }: { iso: string }) => <span className="font-mono text-meta">{utcMinute(iso)}</span>;

/** The step a reader most wants open: where the purchase stopped or waits, else its receipt. */
export function focusStep(detail: PurchaseDetail): TraceStep {
  const order: TraceStep[] = ['mandate', 'gate', 'intent', 'paypal', 'receipt'];
  return order.find((step) => detail.trace[step] === 'stopped') ?? (detail.trace.paypal === 'held' ? 'paypal' : 'receipt');
}

/** The proof behind every step the purchase reached, for an AuthorityTrace. */
export function purchaseProof(detail: PurchaseDetail): TraceProof {
  const { trace, mandate, outcomes, intent, paypal, receipt, approveUrl, cart, sellerSlug } = detail;
  const proof: TraceProof = {
    mandate: (
      <ProofFields
        fields={[
          { label: 'Mandate id', value: <ProofId value={mandate.id} label="Mandate id" /> },
          { label: 'Policy hash', value: <ProofId value={mandate.policyHash} label="Policy hash" /> },
          { label: 'Signed at', value: <Time iso={mandate.confirmedAt} /> },
          { label: 'Confirmed by', value: mandate.confirmation === 'passkey' ? 'Your passkey' : 'Your signed-in session' },
        ]}
      />
    ),
    gate: <RuleResults results={outcomes} />,
  };

  if (trace.intent !== 'not_reached') {
    proof.intent = intent ? (
      <div className="grid gap-1.5">
        <p className="text-text">{INTENT_WORDS[intent.verdict]}</p>
        {intent.reasons.length > 0 && (
          <ul className="grid list-disc gap-0.5 pl-4 text-muted">
            {intent.reasons.map((reason, index) => (
              // Two reasons can read the same.
              <li key={index}>{reason}</li>
            ))}
          </ul>
        )}
      </div>
    ) : (
      <p className="text-muted">Still checking the cart against your request.</p>
    );
  }

  if (trace.paypal !== 'not_reached') {
    proof.paypal =
      trace.paypal === 'held' ? (
        <div className="grid gap-2">
          <p className="text-muted">Waiting for you to approve it at PayPal. Nothing is paid until you do.</p>
          {approveUrl && (
            <a href={approveUrl} className={buttonClass('primary', 'default', 'justify-self-start')}>
              Approve at PayPal
            </a>
          )}
        </div>
      ) : (
        <ProofFields
          fields={[
            { label: 'Order id', value: paypal.orderId ? <ProofId value={paypal.orderId} label="PayPal order id" /> : 'Not created' },
            { label: 'Capture id', value: paypal.captureId ? <ProofId value={paypal.captureId} label="PayPal capture id" /> : 'Not captured' },
            { label: 'Captured at', value: paypal.capturedAt ? <Time iso={paypal.capturedAt} /> : 'Not captured' },
          ]}
        />
      );
  }

  if (receipt) {
    proof.receipt = (
      <div className="grid gap-3">
        <ProofFields
          fields={[
            { label: 'Receipt id', value: <ProofId value={receipt.id} label="Receipt id" /> },
            { label: 'Key id', value: <ProofId value={receipt.keyId} label="Key id" /> },
          ]}
        />
        <JwsView jws={receipt.jws} decoded="folded" token="short" />
        {cart && sellerSlug && <VerifyReceipt jws={receipt.jws} cart={cart} sellerSlug={sellerSlug} />}
      </div>
    );
  } else if (trace.receipt === 'current') {
    proof.receipt = <p className="text-muted">Behest is signing the receipt.</p>;
  }
  return proof;
}

export function PurchaseTrace({
  detail,
  label = 'Authority trace of this purchase',
  defaultOpen,
  className,
}: {
  detail: PurchaseDetail;
  label?: string;
  /** The step open at first; none when omitted. */
  defaultOpen?: TraceStep;
  className?: string;
}) {
  return <AuthorityTrace states={detail.trace} proof={purchaseProof(detail)} label={label} defaultOpen={defaultOpen} className={className} />;
}
