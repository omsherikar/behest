import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { plural } from '@/lib/domain/words';
import { sellerCatalogRows } from '@/lib/seller-pages/catalog';
import { findSeller } from '@/lib/seller-pages/seller';
import { NotOnboarded } from '../not-onboarded';
import { requireSeller } from '../require-seller';
import { CatalogGrid } from './catalog-grid';
import { fillWindow } from '@/components/shell/app-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';

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
    <div className={fillWindow}>
      <PageHeader
        id="catalog-heading"
        title="Your catalog"
        purpose={
          seller
            ? `${plural(rows.length, 'listing')} at ${seller.name}, ${hidden} hidden from agents. Each price sits beside the market median for the same product; well above it, buyers are asked before their agent pays.`
            : 'Your listings, whether agents can buy them, and how each price compares with the market.'
        }
      />
      {!seller ? (
        <NotOnboarded />
      ) : rows.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <CatalogGrid rows={rows} labelledBy="catalog-heading" />
        </div>
      ) : (
        <EmptyState message="Your catalog has no listings yet." action={{ href: '/seller', label: 'Add listings to your shop' }} />
      )}
    </div>
  );
}
