import { buttonClass } from '@/components/ui/button';

// The one place the mandate form's signing actions go: confirming the readback, which signs the
// mandate. Other ways to sign, such as a passkey, belong here beside it, so the form around it does
// not change when one is added. Rendered only by the mandate form, a client component.

export function MandateActions({
  onConfirm,
  confirming,
  disabled,
  questionsOpen,
}: {
  onConfirm: () => void;
  /** Whether the confirmation is under way. */
  confirming: boolean;
  /** Whether confirming is not possible yet, such as while a question is open or a request runs. */
  disabled: boolean;
  /** Whether questions are still open above, so the buyer is told to answer them first. */
  questionsOpen: boolean;
}) {
  return (
    <div className="grid gap-2 rounded-panel border border-line bg-panel p-4">
      <p className="text-body text-muted">
        Confirming signs this mandate. From then on your agent can only pay within it, and every purchase records it.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onConfirm} disabled={disabled} className={buttonClass('primary')}>
          {confirming ? 'Signing...' : 'Confirm and sign'}
        </button>
      </div>
      {questionsOpen && <p className="text-meta text-muted">Answer the questions above before you confirm.</p>}
    </div>
  );
}
