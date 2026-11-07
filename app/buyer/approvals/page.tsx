import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { textLink } from '@/components/ui/link';
import { Notice, TONE_KIND } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { purchaseDetails, type PurchaseDetail } from '@/lib/buyer-pages/detail';
import { returnNotices } from '@/lib/buyer-pages/notices';
import { qrDataUrl } from '@/lib/buyer-pages/qr';
import { requireBuyer } from '../require-buyer';
import { ApprovalsBoard } from './approvals-board';

export const metadata: Metadata = {
  title: 'Approvals',
};

// The purchases waiting for the buyer, each one over what the mandate lets the agent pay alone or
// held back by the intent check, as a list beside the one selected (./approvals-board.tsx): its
// authority trace up to PayPal, why Behest asks, what would have let it through, and the approval
// link with its QR code for a phone. PayPal sends the buyer back here with `?approved=` or
// `?cancelled=` set to the purchase id, or `?pending=` or `?error=` from the return route; each shows
// Behest's own notice. Seller names, item titles and reasons may be a seller's, and are shown as text.

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
    <>
      <PageHeader
        title="Approvals"
        purpose="Purchases your mandate asks you about. Nothing is paid until you approve one at PayPal."
        actions={
          <Link href="/buyer/ledger" className={buttonClass('secondary')}>
            Open your ledger
          </Link>
        }
      />

      {notices.length > 0 && (
        <div className="mb-8 grid gap-3">
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
        <ApprovalsBoard approvals={approvals} codes={codes} />
      )}
    </>
  );
}
