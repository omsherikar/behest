import type { ReactNode } from 'react';
import { buttonClass } from '@/components/ui/button';

// The one place the mandate form's signing actions go: confirming the readback, which signs the
// mandate, and signing it with a passkey beside it. The form around it does not change when a way to
// sign is added. Rendered only by the mandate form, a client component.

export function MandateActions({
  onConfirm,
  confirming,
  disabled,
  questionsOpen,
  passkey,
}: {
  onConfirm: () => void;
  /** Whether the confirmation is under way. */
  confirming: boolean;
  /** Whether confirming is not possible yet, such as while a question is open or a request runs. */
  disabled: boolean;
  /** Whether questions are still open above, so the buyer is told to answer them first. */
  questionsOpen: boolean;
  /** The passkey signing action, shown beside Confirm. */
  passkey?: ReactNode;
}) {
  return (
    <div className="grid gap-3 rounded-panel border border-line bg-raised/40 p-4 sm:p-5">
      <p className="text-body text-muted">
        Confirming signs this mandate. From then on your agent can only pay within it, and every purchase records it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onConfirm} disabled={disabled} className={buttonClass('primary')}>
          {confirming ? 'Signing...' : 'Confirm and sign'}
        </button>
        {passkey}
      </div>
      {questionsOpen && <p className="text-meta text-muted">Answer the questions above before you confirm.</p>}
      {passkey && (
        <p className="text-meta text-muted">
          Signing with a passkey adds your device&apos;s signature over this exact mandate, which anyone can check
          later. Confirming without one rests on your signed-in session alone.
        </p>
      )}
    </div>
  );
}
