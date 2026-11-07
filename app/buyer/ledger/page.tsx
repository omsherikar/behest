import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { fillWindowFromLg } from '@/components/shell/app-shell';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    // The label leads for a screen reader; the figure leads on screen.
    <div className="flex flex-col bg-surface px-5 py-4 sm:px-6 sm:py-5">
      <dt className="order-last mt-1 text-meta text-muted">{label}</dt>
      <dd className="text-[1.75rem] leading-9 font-medium tracking-[-0.03em] text-text tabular-nums">{children}</dd>
    </div>
  );
}

function Figures({ stats }: { stats: LedgerStats }) {
  return (
    <dl className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-frame border border-line bg-line lg:grid-cols-4">
      <Stat label="Proposed by your agent">{stats.proposed}</Stat>
      <Stat label={`Paid, across ${plural(stats.paid, 'purchase')}`}>
        <Money cents={stats.paidCents} />
      </Stat>
      <Stat label="Waiting for your approval">{stats.waiting}</Stat>
      <Stat label="Blocked">{stats.blocked}</Stat>
    </dl>
  );
}

export default async function LedgerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const rows = await purchaseDetails(db, { buyerId: await demoBuyerId(db) }, new Date());

  return (
    <div className={fillWindowFromLg}>
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
          <Figures stats={ledgerStats(rows)} />
          {/* A height of its own on a phone, where the page scrolls; the rest of the window from 1024 px. */}
          <div className="flex h-[32rem] min-h-0 flex-col lg:h-auto lg:flex-1">
            <LedgerGrid rows={rows} labelledBy="ledger-heading" />
          </div>
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
