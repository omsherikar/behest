'use client';

import Link from 'next/link';
import type { RunOutcome } from '@/lib/buyer-pages/agent-events';
import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { statusWords } from '@/lib/buyer-pages/words';
import { AuthorityTrace } from '@/components/ui/authority-trace';
import { buttonClass } from '@/components/ui/button';
import { textLink } from '@/components/ui/link';
import { Money } from '@/components/ui/money';
import { ProofId } from '@/components/ui/proof-id';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { WhatWouldChange } from '@/components/ui/what-would-change';
import type { TraceStates } from '@/lib/ui/trail';
import { purchaseProof } from './purchase-trace';

// One purchase the agent proposed, as the shop's console shows it: first while Behest checks it,
// then decided, with its cart, verdict, status, authority trace, reasons and what would change. The
// trace stays the same element throughout, so once the decision arrives its steps fill in one by
// one. Item titles, sellers and reasons may be a seller's text, and are shown as text.

/** The trace while the purchase is being checked: the mandate holds, the gate is deciding. */
const CHECKING: TraceStates = { mandate: 'done', gate: 'current', intent: 'not_reached', paypal: 'not_reached', receipt: 'not_reached' };

/** "2 × Turmeric, 100 g and 1 more item". */
function itemsLine(items: PurchaseDetail['items']): string {
  if (items.length === 0) return 'A purchase';
  const [first, ...rest] = items;
  const more = rest.length === 0 ? '' : ` and ${rest.length} more ${rest.length === 1 ? 'item' : 'items'}`;
  return `${first.quantity} × ${first.title}${more}`;
}


export function ProposalCard({ outcome, view }: { outcome: RunOutcome | null; view: PurchaseDetail | null }) {
  const decided = outcome !== null;
  const waiting = outcome?.status === 'awaiting_approval';
  // Only the described link: it was checked to be an https PayPal page.
  const approveUrl = view?.approveUrl ?? null;

  return (
    <div className="grid gap-3 rounded-panel border border-line bg-bg/60 p-3 sm:p-4">
      {view ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 font-medium break-words text-text">
            {itemsLine(view.items)} <span className="font-normal text-muted">from {view.seller}</span>
          </p>
          <Money cents={view.totalCents} className="font-medium text-text" />
        </div>
      ) : (
        !decided && <p className="text-muted">Checking it against your mandate...</p>
      )}

      {outcome && (
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={outcome.verdict} />
          <span className="font-medium text-text">{statusWords(outcome.status)}</span>
        </div>
      )}

      {(view || !decided) && (
        <AuthorityTrace
          label={view ? `Authority trace of ${itemsLine(view.items)}` : 'Authority trace of the proposal being checked'}
          states={view?.trace ?? CHECKING}
          proof={view ? purchaseProof(view) : {}}
        />
      )}

      {outcome && outcome.reasons.length > 0 && (
        <ul className="grid list-disc gap-0.5 pl-4 text-body break-words text-muted">
          {outcome.reasons.map((reason, index) => (
            // Two reasons can read the same.
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}

      {view && <WhatWouldChange change={view.change} reasons={outcome?.reasons} />}

      {waiting && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {approveUrl && (
            <a href={approveUrl} className={buttonClass('primary')}>
              Approve at PayPal
            </a>
          )}
          <Link href="/buyer/approvals" className={`text-body ${textLink}`}>
            See it on your approvals page
          </Link>
        </div>
      )}

      {outcome?.receiptId && (
        <p className="flex flex-wrap items-center gap-2 text-meta text-muted">
          Receipt <ProofId value={outcome.receiptId} label="Receipt id" />
        </p>
      )}
    </div>
  );
}
