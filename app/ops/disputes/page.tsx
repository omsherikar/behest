import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { plural } from '@/lib/domain/words';
import { disputeRows } from '@/lib/ops-pages/disputes';
import { requireOperator } from '../require-operator';
import { DisputesGrid } from './disputes-grid';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = {
  title: 'Disputes',
};

// Every dispute buyers opened against Behest at PayPal. Behest is the merchant of record, so it
// answers each one with evidence; the operator opens a dispute to draft, review and submit it.

export default async function DisputesPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireOperator();

  const rows = await disputeRows(appDb());
  const submitted = rows.filter((row) => row.submitted).length;

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        id="disputes-heading"
        title="Disputes"
        purpose={`${plural(rows.length, 'dispute')} opened by buyers at PayPal, ${submitted} answered with evidence. Behest answers each one as the merchant of record, from its signed records. Open a dispute to draft, review and submit its answer.`}
      />
      {rows.length > 0 ? (
        <div>
          <DisputesGrid rows={rows} labelledBy="disputes-heading" />
        </div>
      ) : (
        <EmptyState
          message="No buyer has opened a dispute yet. When one does, PayPal tells Behest and it appears here, matched to its purchase."
          action={{ href: '/dashboard', label: 'Open the dashboard' }}
        />
      )}
    </div>
  );
}
