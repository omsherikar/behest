import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { connection } from 'next/server';
import { PurchaseTrace } from '@/components/purchase/purchase-trace';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { Notice, TONE_KIND } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { WhatWouldChange } from '@/components/ui/what-would-change';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { purchaseDetails, type PurchaseDetail } from '@/lib/buyer-pages/detail';
import { returnNotices } from '@/lib/buyer-pages/notices';
import { qrDataUrl } from '@/lib/buyer-pages/qr';
import { requireBuyer } from '../require-buyer';

export const metadata: Metadata = {
  title: 'Approvals',
};

// The purchases waiting for the buyer, each one over what the mandate lets the agent pay alone or
// held back by the intent check. Each card shows the purchase, its authority trace up to PayPal,
// why Behest asks, what would have let it through, and the approval link with its QR code for a
// phone. PayPal sends the buyer back here with `?approved=` or `?cancelled=` set to the purchase id,
// or `?pending=` or `?error=` from the return route; each shows Behest's own notice. Seller names,
// item titles and reasons may be a seller's, and are shown as text.

const textLink = 'font-medium text-action underline-offset-2 hover:text-action-strong hover:underline';

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

/** A QR code of the approval link, or null when there is no link or it could not be drawn. */
async function qrFor(approval: PurchaseDetail): Promise<string | null> {
  if (!approval.approveUrl) return null;
  try {
    return await qrDataUrl(approval.approveUrl);
  } catch (failure) {
    console.error('[approvals] Could not draw the QR code of an approval link:', failure);
    return null;
  }
}

export default async function ApprovalsPage({ searchParams }: PageProps<'/buyer/approvals'>) {
  // Reads the database on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const approvals = await purchaseDetails(db, { buyerId: await demoBuyerId(db), status: 'awaiting_approval' }, new Date());
  const codes = await Promise.all(approvals.map(qrFor));
  const notices = returnNotices(await searchParams);

  return (
    <div className="w-full max-w-3xl">
      <PageHeader
        title="Approvals"
        purpose="Purchases your mandate asks you about. Nothing is paid until you approve one at PayPal."
      />

      {notices.length > 0 && (
        <div className="mb-6 grid gap-3">
          {notices.map((notice) => (
            <Notice key={notice.text} kind={TONE_KIND[notice.tone]}>
              {notice.text}
              {notice.ledger && (
                <>
                  {' '}
                  <Link href="/buyer/ledger" className={textLink}>
                    Open your ledger
                  </Link>
                </>
              )}
            </Notice>
          ))}
        </div>
      )}

      {approvals.length === 0 ? (
        <EmptyState
          message="Nothing is waiting for your approval. When your agent proposes a purchase your mandate asks you about, it waits here until you decide."
          action={{ href: '/buyer/shop', label: 'Send your agent shopping' }}
        />
      ) : (
        <ul className="grid gap-5">
          {approvals.map((approval, index) => (
            <Approval key={approval.id} approval={approval} qrCode={codes[index]} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Approval({ approval, qrCode }: { approval: PurchaseDetail; qrCode: string | null }) {
  const headingId = `approval-${approval.id}`;
  return (
    <li aria-labelledby={headingId} className="grid gap-4 rounded-panel border border-line bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={headingId} className="text-lead font-medium break-words text-text">
          {approval.seller}
        </h2>
        <Money cents={approval.totalCents} missing="Amount unknown" className="text-lead font-medium text-text" />
      </div>
      <div className="-mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <VerdictBadge verdict={approval.verdict} />
        <span className="text-meta text-muted">Proposed {dateTime.format(new Date(approval.createdAt))} UTC</span>
      </div>

      {approval.items.length > 0 && (
        <section aria-label="What it buys">
          <ul className="grid gap-1 text-body">
            {approval.items.map((item) => (
              <li key={item.sku} className="flex justify-between gap-4">
                <span className="min-w-0 break-words text-text">
                  {item.quantity} × {item.title} <span className="font-mono text-meta text-muted">{item.sku}</span>
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
          <ul className="mt-1 grid list-disc gap-0.5 pl-4 text-body break-words text-text marker:text-muted">
            {approval.reasons.map((reason, index) => (
              // Two reasons can read the same.
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      <WhatWouldChange change={approval.change} reasons={approval.reasons} />

      {approval.approveUrl ? (
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <a href={approval.approveUrl} className={buttonClass('primary')}>
            Approve at PayPal
          </a>
          {qrCode && (
            <figure className="flex items-center gap-3">
              <Image
                src={qrCode}
                alt="QR code of the PayPal approval link"
                width={112}
                height={112}
                unoptimized
                className="size-28 rounded-control border border-line bg-white p-1"
              />
              <figcaption className="max-w-40 text-meta text-muted">Scan it to approve on your phone.</figcaption>
            </figure>
          )}
        </div>
      ) : (
        <p className="text-body text-muted">The approval link is not ready yet. Refresh the page in a moment.</p>
      )}
    </li>
  );
}
