import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { ledgerRows } from '@/lib/buyer-pages/purchases';
import { plural } from '@/lib/domain/words';
import { requireBuyer } from '../require-buyer';
import { LedgerGrid } from './ledger-grid';
import { fillWindow } from '@/components/shell/app-shell';

export const metadata: Metadata = {
  title: 'Your ledger',
};

// Every purchase the buyer's agent proposed, whatever became of it: paid, waiting for the buyer,
// or not bought, with Behest's verdict, the reasons and the signed receipt of each paid one.

export default async function LedgerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const rows = await ledgerRows(db, await demoBuyerId(db));

  return (
    <div className={fillWindow}>
      <h1 id="ledger-heading" className="text-[28px] font-semibold text-pp-navy">
        Your ledger
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-pp-muted">
        {plural(rows.length, 'purchase')} your agent proposed. Each one shows Behest&apos;s verdict, where it stands and
        why it was not simply allowed. A paid purchase has a receipt Behest signed, which the seller checks before
        accepting the order.
      </p>
      {rows.length > 0 ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <LedgerGrid rows={rows} labelledBy="ledger-heading" />
        </div>
      ) : (
        <p className="mt-6 text-pp-muted">Your agent has not proposed a purchase yet.</p>
      )}
    </div>
  );
}
