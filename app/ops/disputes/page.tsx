import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { disputeRows } from '@/lib/ops-pages/disputes';
import { requireOperator } from '../require-operator';
import { DisputesGrid } from './disputes-grid';
import { EmptyState } from '@/components/ui/empty-state';
import { Figure, Figures } from '@/components/ui/figures';
import { Money } from '@/components/ui/money';
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
  const matched = rows.filter((row) => row.linked).length;
  const disputedCents = rows.reduce((sum, row) => sum + row.amountCents, 0);

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        id="disputes-heading"
        title="Disputes"
        purpose="Behest answers each dispute as the merchant of record, from its signed records. Open one to draft, review and submit its answer."
      />
      {rows.length > 0 ? (
        <>
          <Figures>
            <Figure label="Opened by buyers at PayPal">{rows.length}</Figure>
            <Figure label="Matched to a purchase">{matched}</Figure>
            <Figure label="Answered with evidence" tone={submitted < rows.length ? 'text-hold' : 'text-seal'}>
              {submitted}
            </Figure>
            <Figure label="Disputed in total">
              <Money cents={disputedCents} />
            </Figure>
          </Figures>
          <DisputesGrid rows={rows} labelledBy="disputes-heading" />
        </>
      ) : (
        <EmptyState
          message="No buyer has opened a dispute yet. When one does, PayPal tells Behest and it appears here, matched to its purchase."
          action={{ href: '/dashboard', label: 'Open the dashboard' }}
        />
      )}
    </div>
  );
}
