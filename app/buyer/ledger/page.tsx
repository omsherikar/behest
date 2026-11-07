import type { Metadata } from 'next';
import { connection } from 'next/server';
import { fillWindow } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { purchaseDetails } from '@/lib/buyer-pages/detail';
import { plural } from '@/lib/domain/words';
import { requireBuyer } from '../require-buyer';
import { LedgerGrid } from './ledger-grid';

export const metadata: Metadata = {
  title: 'Your ledger',
};

// Every purchase the buyer's agent proposed, whatever became of it: paid, waiting for the buyer,
// or not bought, with Behest's verdict, its trace, the reasons and the signed receipt of each paid
// one. Each row opens the full trace and its proof, read here on the server as plain data.

export default async function LedgerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const rows = await purchaseDetails(db, { buyerId: await demoBuyerId(db) }, new Date());

  return (
    <div className={fillWindow}>
      <PageHeader
        id="ledger-heading"
        title="Your ledger"
        purpose={
          rows.length > 0
            ? `${plural(rows.length, 'purchase')} your agent proposed. Select one, or press Enter on it, to see its full trace and the proof behind each step.`
            : 'Every purchase your agent proposes, with the trace that authorized it.'
        }
      />
      {rows.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <LedgerGrid rows={rows} labelledBy="ledger-heading" />
        </div>
      ) : (
        <EmptyState
          message="Your agent has not proposed a purchase yet. Send it shopping, and every purchase it proposes shows up here with its trace and receipt."
          action={{ href: '/buyer/shop', label: 'Send your agent shopping' }}
        />
      )}
    </div>
  );
}
