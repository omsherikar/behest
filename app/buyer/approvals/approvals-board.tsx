'use client';

import Image from 'next/image';
import { useId, useRef, useState } from 'react';
import { PurchaseTrace } from '@/components/purchase/purchase-trace';
import { buttonClass } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { WhatWouldChange } from '@/components/ui/what-would-change';
import type { PurchaseDetail } from '@/lib/buyer-pages/detail';
import { cn } from '@/lib/utils';

// The purchases waiting for the buyer, as a list beside the one selected: its cart, its authority
// trace up to PayPal, why Behest asks, what would have let it through, and the approval link with its
// QR code for a phone. From 1024 px the list and the detail sit side by side; on a phone the detail
// follows the list, and choosing an item scrolls to it. Seller names, item titles and reasons may be
// a seller's text, and are shown as text.

// 7 Nov 2026, 09:00, in UTC as the page says.
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/** "2 × Turmeric, 100 g and 1 more item". */
function itemsLine(items: PurchaseDetail['items']): string {
  if (items.length === 0) return 'No cart';
  const [first, ...rest] = items;
  return `${first.quantity} × ${first.title}${rest.length === 0 ? '' : ` and ${rest.length} more ${rest.length === 1 ? 'item' : 'items'}`}`;
}

export function ApprovalsBoard({ approvals, codes }: { approvals: PurchaseDetail[]; codes: (string | null)[] }) {
  const [selectedId, setSelectedId] = useState(approvals[0]?.id);
  const detail = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const index = Math.max(0, approvals.findIndex((approval) => approval.id === selectedId));
  const selected = approvals[index];

  function choose(id: string) {
    setSelectedId(id);
    // On a phone the detail is under the list, out of sight.
    if (window.matchMedia('(max-width: 1023px)').matches) detail.current?.scrollIntoView({ block: 'start' });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-12 lg:gap-x-6 xl:gap-x-8">
      <section aria-labelledby="waiting-heading" className="min-w-0 lg:sticky lg:top-28 lg:col-span-5 lg:self-start">
        <h2 id="waiting-heading" className="mb-3 text-meta text-muted">
          {approvals.length === 1 ? '1 purchase is waiting for you' : `${approvals.length} purchases are waiting for you`}
        </h2>
        <ul className="grid gap-2">
          {approvals.map((approval) => {
            const here = approval.id === selected.id;
            return (
              <li key={approval.id}>
                <button
                  type="button"
                  aria-current={here ? 'true' : undefined}
                  aria-controls={detailId}
                  onClick={() => choose(approval.id)}
                  className={cn(
                    'grid w-full gap-2 rounded-panel border p-4 text-left transition-colors',
                    here ? 'border-line-strong bg-raised shadow-[var(--highlight)]' : 'border-line bg-surface hover:border-line-strong hover:bg-raised/60',
                  )}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 font-medium break-words text-text">{approval.seller}</span>
                    <Money cents={approval.totalCents} missing="Amount unknown" mono className="shrink-0 text-body text-text" />
                  </span>
                  <span className="text-body break-words text-muted">{itemsLine(approval.items)}</span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <VerdictBadge verdict={approval.verdict} />
                    <span className="text-meta text-muted">{dateTime.format(new Date(approval.createdAt))} UTC</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <div ref={detail} id={detailId} className="min-w-0 scroll-mt-28 lg:col-span-7">
        <ApprovalDetail key={selected.id} approval={selected} qrCode={codes[index] ?? null} />
      </div>
    </div>
  );
}

function ApprovalDetail({ approval, qrCode }: { approval: PurchaseDetail; qrCode: string | null }) {
  const headingId = useId();
  return (
    <article aria-labelledby={headingId} className="panel grid gap-6 rounded-frame p-5 sm:p-6">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={headingId} className="text-heading font-medium break-words text-text">
            {approval.seller}
          </h2>
          <Money cents={approval.totalCents} missing="Amount unknown" className="text-heading font-medium text-text" />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <VerdictBadge verdict={approval.verdict} />
          <span className="text-meta text-muted">Proposed {dateTime.format(new Date(approval.createdAt))} UTC</span>
        </div>
      </header>

      {approval.items.length > 0 && (
        <section aria-label="What it buys" className="rounded-panel border border-line">
          <ul className="divide-y divide-line">
            {approval.items.map((item) => (
              <li key={item.sku} className="flex items-baseline justify-between gap-4 px-4 py-3 text-body">
                <span className="min-w-0 break-words text-text">
                  {item.quantity} × {item.title} <span className="ml-1 font-mono text-meta text-muted">{item.sku}</span>
                </span>
                <Money cents={item.unitPriceCents * item.quantity} mono className="shrink-0 text-meta text-text" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <PurchaseTrace detail={approval} label={`Authority trace of the purchase from ${approval.seller}`} />

      {approval.reasons.length > 0 && (
        <section aria-labelledby={`${headingId}-why`}>
          <h3 id={`${headingId}-why`} className="text-meta text-muted">
            Why Behest asks you
          </h3>
          <ul className="mt-1.5 grid gap-1">
            {approval.reasons.map((reason, index) => (
              // Two reasons can read the same.
              <li key={index} className="flex gap-2.5 text-body break-words text-text">
                <span aria-hidden className="mt-2.5 size-1 shrink-0 rounded-full bg-hold" />
                {reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <WhatWouldChange change={approval.change} reasons={approval.reasons} />

      {approval.approveUrl ? (
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-5 border-t border-line pt-6">
          <div className="grid gap-2">
            <a href={approval.approveUrl} className={buttonClass('primary', 'large', 'justify-self-start')}>
              Approve at PayPal
            </a>
            <p className="text-meta text-muted">Nothing is paid until you approve it there.</p>
          </div>
          {/* Not on a phone, where the buyer already is: the button is the way there. */}
          {qrCode && (
            <figure className="hidden items-center gap-3 sm:flex">
              <Image
                src={qrCode}
                alt="QR code of the PayPal approval link"
                width={112}
                height={112}
                unoptimized
                className="size-28 rounded-control border border-line bg-white p-1"
              />
              <figcaption className="text-meta whitespace-nowrap text-muted">Or scan it on your phone</figcaption>
            </figure>
          )}
        </div>
      ) : (
        <p className="border-t border-line pt-6 text-body text-muted">The approval link is not ready yet. Refresh the page in a moment.</p>
      )}
    </article>
  );
}
