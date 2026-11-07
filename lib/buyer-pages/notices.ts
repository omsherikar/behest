// The notices on the buyer's approvals page after PayPal sends them back. The link says which
// (`approved`, `pending` or `cancelled`, each with a purchase id, or `error`), and the notice is
// Behest's own fixed text: nothing the link carries is shown.

export type ReturnNotice = {
  tone: 'success' | 'warning' | 'danger';
  text: string;
  /** Whether the notice points to the ledger, where the purchase's outcome shows. */
  ledger: boolean;
};

const APPROVED: ReturnNotice = {
  tone: 'success',
  text: 'You approved the purchase at PayPal. Your ledger shows whether the payment went through.',
  ledger: true,
};
const PENDING: ReturnNotice = {
  tone: 'warning',
  text: 'PayPal has not confirmed your approval yet, so nothing was paid. If the purchase is still listed below, approve it at PayPal again.',
  ledger: false,
};
const CANCELLED: ReturnNotice = {
  tone: 'warning',
  text: 'You left PayPal without approving the purchase, so nothing was paid.',
  ledger: false,
};
const ERRORS = new Map<unknown, ReturnNotice>([
  [
    'unknown',
    {
      tone: 'danger',
      text: 'Behest could not match that PayPal approval to one of your purchases, so nothing was done.',
      ledger: false,
    },
  ],
  [
    'failed',
    {
      tone: 'danger',
      text: 'Behest could not finish your approval just now. Wait a minute and open the PayPal link again. Your ledger shows where each purchase stands.',
      ledger: true,
    },
  ],
]);

/** The notices the approvals page's query asks for, in a fixed order. An `error` it does not know shows nothing. */
export function returnNotices(query: Record<string, string | string[] | undefined>): ReturnNotice[] {
  const error = ERRORS.get(query.error);
  return [
    query.approved !== undefined && APPROVED,
    query.pending !== undefined && PENDING,
    query.cancelled !== undefined && CANCELLED,
    error,
  ].filter((notice): notice is ReturnNotice => Boolean(notice));
}
