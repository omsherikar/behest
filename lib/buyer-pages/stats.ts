import type { PurchaseStatus } from '@/lib/db/schema';
import type { Verdict } from '@/lib/domain/verdict';

// The figures over the buyer's ledger, counted from the rows the grid shows: everything the agent
// proposed, what was paid and for how much, what waits for the buyer, and what was blocked. Paid
// means the statuses the buyer's pages call paid, so a refunded purchase no longer counts.

/** The statuses whose words start with "Paid" in lib/buyer-pages/words.ts. */
const PAID: ReadonlySet<string> = new Set<PurchaseStatus>(['captured', 'accepted', 'settled', 'disputed', 'resolved']);

export type LedgerStats = { proposed: number; paid: number; paidCents: number; waiting: number; blocked: number };

export function ledgerStats(rows: readonly { status: string; verdict: Verdict; totalCents: number | null }[]): LedgerStats {
  const paid = rows.filter((row) => PAID.has(row.status));
  return {
    proposed: rows.length,
    paid: paid.length,
    paidCents: paid.reduce((sum, row) => sum + (row.totalCents ?? 0), 0),
    waiting: rows.filter((row) => row.status === 'awaiting_approval').length,
    blocked: rows.filter((row) => row.verdict === 'BLOCK').length,
  };
}
