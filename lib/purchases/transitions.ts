import type { PurchaseStatus } from '@/lib/db/schema';

export type { PurchaseStatus };

/**
 * The purchase lifecycle: for each status, the statuses a purchase may move to next. This table
 * is the single source of truth; the orchestrator calls `assertTransition` before every status
 * change. Staying in the same status is not a transition, so no status lists itself.
 */
export const ALLOWED: Readonly<Record<PurchaseStatus, readonly PurchaseStatus[]>> = {
  proposed: ['blocked', 'charging', 'awaiting_approval'],
  awaiting_approval: ['charging', 'cancelled'],
  // Back to `awaiting_approval` only when PayPal refuses to capture an approval order with
  // ORDER_NOT_APPROVED: no money moved, and the buyer can still approve the order.
  charging: ['captured', 'failed', 'awaiting_approval'],
  captured: ['accepted', 'refunded'],
  accepted: ['settled', 'refunded'],
  settled: ['disputed', 'refunded'],
  disputed: ['resolved', 'refunded'],
  blocked: [],
  cancelled: [],
  failed: [],
  refunded: [],
  resolved: [],
};

/**
 * Statuses whose amount counts toward the mandate's budget: everything except a purchase that
 * never charged (blocked, cancelled, failed) or whose money came back (refunded).
 */
export const COUNTS_AGAINST_BUDGET: readonly PurchaseStatus[] = [
  'proposed',
  'charging',
  'awaiting_approval',
  'captured',
  'accepted',
  'settled',
  'disputed',
  'resolved',
];

export class IllegalTransition extends Error {
  readonly from: PurchaseStatus;
  readonly to: PurchaseStatus;
  constructor(from: PurchaseStatus, to: PurchaseStatus) {
    super(`cannot move a purchase from ${from} to ${to}`);
    this.name = 'IllegalTransition';
    this.from = from;
    this.to = to;
  }
}

/** Whether the lifecycle lets a purchase move from `from` to `to`. */
export function canTransition(from: PurchaseStatus, to: PurchaseStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Throws an IllegalTransition unless the lifecycle lets a purchase move from `from` to `to`. */
export function assertTransition(from: PurchaseStatus, to: PurchaseStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransition(from, to);
}
