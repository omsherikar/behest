import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { disputes, type StoredEvidenceItem, type StoredNarrative } from '@/lib/db/schema';

// The operator's disputes pages: every dispute PayPal opened against Behest, and one dispute with
// the evidence items of its last draft and, once submitted, the narrative PayPal was sent. Reasons
// and statuses are PayPal's codes, read as words. The buyer's notes are kept exactly as PayPal sent
// them; the page shows them as plain text.

export type DisputeRow = {
  id: string;
  paypalDisputeId: string;
  /** When the buyer opened the dispute, as an ISO timestamp, or null when PayPal gave no time. */
  openedAt: string | null;
  reason: string;
  status: string;
  amountCents: number;
  /** Whether the dispute is matched to a purchase, which is what Behest's evidence comes from. */
  linked: boolean;
  /** Whether evidence for it was submitted to PayPal. */
  submitted: boolean;
};

export type DisputeView = Omit<DisputeRow, 'submitted'> & {
  buyerNotes: string | null;
  /** The evidence items of the pack stored by the last draft, or null before any draft. */
  items: StoredEvidenceItem[] | null;
  /**
   * The narrative of a submission PayPal did not take, for the operator to start from again. Null
   * once submitted, and when there was no such submission.
   */
  lastNarrative: StoredNarrative | null;
  /** When evidence was submitted and the narrative sent, or null until then. */
  submitted: { at: string; narrative: StoredNarrative | null } | null;
};

/** `SOME_CODE` or `some_code` as "Some code". */
export function codeWords(code: string): string {
  const text = code.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Every dispute as the list shows it, latest opened first, and those PayPal gave no time last. */
export async function disputeRows(db: Db): Promise<DisputeRow[]> {
  const rows = await db
    .select({
      id: disputes.id,
      paypalDisputeId: disputes.paypalDisputeId,
      openedAt: disputes.openedAt,
      reason: disputes.reason,
      status: disputes.status,
      amountCents: disputes.amountCents,
      purchaseId: disputes.purchaseId,
      submittedAt: disputes.submittedAt,
    })
    .from(disputes)
    .orderBy(sql`${disputes.openedAt} desc nulls last`, desc(disputes.createdAt), desc(disputes.id));
  return rows.map((row) => ({
    id: row.id,
    paypalDisputeId: row.paypalDisputeId,
    openedAt: row.openedAt?.toISOString() ?? null,
    reason: codeWords(row.reason),
    status: codeWords(row.status),
    amountCents: row.amountCents,
    linked: row.purchaseId !== null,
    submitted: row.submittedAt !== null,
  }));
}

/** The dispute whose row id is `id` as its page shows it, or null when there is none. */
export async function disputeView(db: Db, id: string): Promise<DisputeView | null> {
  // Dispute ids are UUIDs; Postgres would refuse anything else as an error rather than find nothing.
  if (!z.guid().safeParse(id).success) return null;
  const [row] = await db.select().from(disputes).where(eq(disputes.id, id));
  if (!row) return null;
  return {
    id: row.id,
    paypalDisputeId: row.paypalDisputeId,
    openedAt: row.openedAt?.toISOString() ?? null,
    reason: codeWords(row.reason),
    status: codeWords(row.status),
    amountCents: row.amountCents,
    linked: row.purchaseId !== null,
    buyerNotes: row.buyerNotes,
    items: row.evidencePack?.items ?? null,
    // Only the submit route writes a narrative, and it clears the submission time when PayPal fails.
    lastNarrative: row.submittedAt === null ? row.narrative : null,
    submitted: row.submittedAt === null ? null : { at: row.submittedAt.toISOString(), narrative: row.narrative },
  };
}
