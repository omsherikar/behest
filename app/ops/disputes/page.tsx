import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { plural } from '@/lib/domain/words';
import { disputeRows } from '@/lib/ops-pages/disputes';
import { requireOperator } from '../require-operator';
import { DisputesGrid } from './disputes-grid';

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
    <main className="flex h-dvh flex-col overflow-y-auto bg-pp-canvas px-4 py-6 font-paypal text-pp-ink sm:px-8">
      <h1 id="disputes-heading" className="text-[28px] font-semibold text-pp-navy">
        Disputes
      </h1>
      <p className="mt-2 max-w-3xl text-sm text-pp-muted">
        {plural(rows.length, 'dispute')} opened by buyers at PayPal, {submitted} answered with evidence. Behest answers
        each one as the merchant of record, with the signed mandate, its readback, the signed receipt, the cart and the
        purchase log. Open a dispute to draft its narrative, review it and submit it to PayPal.
      </p>
      {rows.length > 0 ? (
        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <DisputesGrid rows={rows} labelledBy="disputes-heading" />
        </div>
      ) : (
        <p className="mt-6 text-pp-muted">No buyer has opened a dispute yet.</p>
      )}
    </main>
  );
}
