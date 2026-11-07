import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Figure, Figures } from '@/components/ui/figures';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { purchaseDetails } from '@/lib/buyer-pages/detail';
import { type LedgerStats, ledgerStats } from '@/lib/buyer-pages/stats';
import { plural } from '@/lib/domain/words';
import { requireBuyer } from '../require-buyer';
import { LedgerGrid } from './ledger-grid';

export const metadata: Metadata = {
  title: 'Your ledger',
};

// Every purchase the buyer's agent proposed, whatever became of it: four figures across the top,
// then the full-width grid with Behest's verdict, its trace, the reasons and the signed receipt of
// each paid one. Each row opens the full trace and its proof, read here on the server as plain data.

function LedgerFigures({ stats }: { stats: LedgerStats }) {
  return (
    <Figures>
      <Figure label="Proposed by your agent">{stats.proposed}</Figure>
      <Figure label={`Paid, across ${plural(stats.paid, 'purchase')}`}>
        <Money cents={stats.paidCents} />
      </Figure>
      <Figure label="Waiting for your approval">{stats.waiting}</Figure>
      <Figure label="Blocked">{stats.blocked}</Figure>
    </Figures>
  );
}

export default async function LedgerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const rows = await purchaseDetails(db, { buyerId: await demoBuyerId(db) }, new Date());

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        id="ledger-heading"
        title="Your ledger"
        purpose={
          rows.length > 0
            ? 'Every purchase your agent proposed. Select one, or press Enter on it, to see its full trace and proof.'
            : 'Every purchase your agent proposes, with the trace that authorized it.'
        }
        actions={
          <Link href="/buyer/shop" className={buttonClass('secondary')}>
            Send your agent shopping
          </Link>
        }
      />
      {rows.length > 0 ? (
        <>
          <LedgerFigures stats={ledgerStats(rows)} />
          <LedgerGrid rows={rows} labelledBy="ledger-heading" />
        </>
      ) : (
        <EmptyState
          message="Your agent has not proposed a purchase yet. Send it shopping, and every purchase it proposes shows up here with its trace and receipt."
          action={{ href: '/buyer/shop', label: 'Send your agent shopping' }}
        />
      )}
    </div>
  );
}
