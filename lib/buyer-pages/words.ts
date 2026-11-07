import type { PurchaseStatus } from '@/lib/db/schema';

// How the buyer's pages word a purchase and an agent run, in the same terms the shopping agent uses
// when it tells the buyer what happened. The status is what counts: an ALLOW verdict is not a payment.

const STATUS_WORDS: Record<PurchaseStatus, string> = {
  proposed: 'Being checked',
  charging: 'Confirming payment',
  awaiting_approval: 'Approve at PayPal',
  captured: 'Paid',
  accepted: 'Paid',
  settled: 'Paid',
  disputed: 'Paid, in dispute',
  resolved: 'Paid, dispute closed',
  refunded: 'Refunded',
  blocked: 'Not bought',
  failed: 'Not bought',
  cancelled: 'Not bought, approval cancelled',
};

/** A purchase status in the buyer's words, such as "Paid" for `captured`. A status Behest does not know is given as it is. */
export function statusWords(status: string): string {
  return Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status as PurchaseStatus] : status;
}
