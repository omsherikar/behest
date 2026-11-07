import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { connection } from 'next/server';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { returnNotices, type ReturnNotice } from '@/lib/buyer-pages/notices';
import { pendingApprovals, type PendingApproval } from '@/lib/buyer-pages/purchases';
import { qrDataUrl } from '@/lib/buyer-pages/qr';
import { formatUsd } from '@/lib/domain/money';
import { requireBuyer } from '../require-buyer';

export const metadata: Metadata = {
  title: 'Approvals',
};

// The purchases waiting for the buyer, each one over what the mandate lets the agent pay alone or
// held back by the intent check. The buyer approves each at PayPal, by its link or by scanning its
// QR code on a phone. PayPal sends the buyer back here with `?approved=` or `?cancelled=` set to the
// purchase id, or `?pending=` or `?error=` from the return route; each shows Behest's own notice.
// Seller names, item titles and reasons are shown as text, as they may be a seller's.

const primaryLink =
  'inline-flex h-10 items-center justify-center rounded-full bg-pp-blue px-5 font-semibold text-on-fill transition-colors hover:bg-pp-blue-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';
const NOTICE_STYLES: Record<ReturnNotice['tone'], string> = {
  success: 'border-pp-success text-pp-success',
  warning: 'border-pp-warning text-pp-warning',
  danger: 'border-pp-danger text-pp-danger',
};
const textLink =
  'font-semibold text-pp-blue underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';

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
async function qrFor(approval: PendingApproval): Promise<string | null> {
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
  const approvals = await pendingApprovals(db, await demoBuyerId(db));
  const codes = await Promise.all(approvals.map(qrFor));
  const notices = returnNotices(await searchParams);

  return (
    <div className="w-full max-w-2xl">
      <h1 className="text-3xl font-semibold text-pp-navy">Approvals</h1>
      <p className="mt-3 text-pp-muted">
        Your agent proposed these purchases, and your mandate says you decide. Nothing is paid until you approve a
        purchase at PayPal.
      </p>

      {notices.map((notice) => (
        <p
          key={notice.text}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          className={`mt-6 rounded-xl border bg-pp-surface p-4 text-sm ${NOTICE_STYLES[notice.tone]}`}
        >
          {notice.text}
          {notice.ledger && (
            <>
              {' '}
              <Link href="/buyer/ledger" className={textLink}>
                Open your ledger
              </Link>
            </>
          )}
        </p>
      ))}

      {approvals.length === 0 ? (
        <p className="mt-8 text-pp-muted">
          Nothing is waiting for your approval.{' '}
          <Link href="/buyer/shop" className={textLink}>
            Send your agent shopping
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-8 flex flex-col gap-6">
          {approvals.map((approval, index) => (
            <Approval key={approval.id} approval={approval} qrCode={codes[index]} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Approval({ approval, qrCode }: { approval: PendingApproval; qrCode: string | null }) {
  return (
    <li className="rounded-xl border border-pp-border bg-pp-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-semibold break-words text-pp-navy">
          {approval.seller}
        </h2>
        <p className="text-lg font-semibold">
          {approval.totalCents === null ? 'Amount unknown' : formatUsd(approval.totalCents)}
        </p>
      </div>
      <p className="mt-1 text-sm text-pp-muted">Proposed {dateTime.format(approval.createdAt)} (UTC)</p>

      {approval.items.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-pp-navy">What it buys</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {approval.items.map((item) => (
              <li key={item.sku} className="flex justify-between gap-4">
                <span className="min-w-0 break-words">
                  {item.quantity} × {item.title}
                </span>
                <span className="shrink-0">{formatUsd(item.unitPriceCents * item.quantity)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {approval.reasons.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold text-pp-navy">Why Behest asks you</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm break-words">
            {approval.reasons.map((reason, index) => (
              // Two reasons can read the same.
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </>
      )}

      {approval.approveUrl ? (
        <div className="mt-5 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <a href={approval.approveUrl} className={primaryLink}>
            Approve at PayPal
          </a>
          {qrCode && (
            <figure className="flex items-center gap-3">
              <Image
                src={qrCode}
                alt="QR code of the PayPal approval link"
                width={120}
                height={120}
                unoptimized
                className="size-30 rounded-lg border border-pp-border"
              />
              <figcaption className="max-w-40 text-sm text-pp-muted">Scan it to approve on your phone.</figcaption>
            </figure>
          )}
        </div>
      ) : (
        <p className="mt-5 text-sm text-pp-muted">Approval link unavailable</p>
      )}
    </li>
  );
}
