import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { plural } from '@/lib/domain/words';
import { sellerCatalogRows } from '@/lib/seller-pages/catalog';
import { findSeller } from '@/lib/seller-pages/seller';
import { NotOnboarded } from '../not-onboarded';
import { requireSeller } from '../require-seller';
import { SellerNav } from '../seller-nav';
import { CatalogGrid } from './catalog-grid';

export const metadata: Metadata = {
  title: 'Your catalog',
};

export default async function SellerCatalogPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const db = appDb();
  const seller = await findSeller(db, DEMO_SELLER_SLUG);
  const rows = seller ? await sellerCatalogRows(db, seller.id) : [];
  const hidden = rows.filter((row) => row.hiddenReason !== null).length;

  return (
    <main className="flex h-dvh flex-col overflow-y-auto bg-pp-canvas px-4 py-6 font-paypal text-pp-ink sm:px-8">
      <SellerNav current="/seller/catalog" />
      <h1 className="mt-4 text-[28px] font-semibold text-pp-navy">Your catalog</h1>
      {seller ? (
        <>
          <p className="mt-2 max-w-3xl text-sm text-pp-muted">
            {plural(rows.length, 'listing')} at {seller.name}, {hidden} hidden from agents. Behest hides a listing whose
            text speaks to AI agents: shopping agents cannot see or buy it. The market median is the typical price of
            the same product elsewhere; when your price is well above it, the buyer is asked before their agent pays.
          </p>
          {rows.length > 0 ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col">
              <CatalogGrid rows={rows} />
            </div>
          ) : (
            <p className="mt-6 text-pp-muted">Your catalog has no listings.</p>
          )}
        </>
      ) : (
        <NotOnboarded />
      )}
    </main>
  );
}
