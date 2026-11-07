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
import { EmptyState } from '@/components/ui/empty-state';
import { Figure, Figures } from '@/components/ui/figures';
import { PageHeader } from '@/components/ui/page-header';
import { PRICE_ANOMALY_RATIO } from '@/lib/gate/rules';
import { benchmark } from '@/lib/seller-pages/benchmark';
import type { CatalogRow } from '@/lib/seller-pages/catalog';

export const metadata: Metadata = {
  title: 'Your catalog',
};

// The seller's listings over a full-width grid, under four figures on how shopping agents see them:
// how many are listed, hidden, priced far enough above the market that buyers are asked first, or
// without a benchmark, counted from the same rows the grid shows, with the price rule the gate applies.

function AgentView({ rows }: { rows: CatalogRow[] }) {
  const hidden = rows.filter((row) => row.hiddenReason !== null).length;
  const marks = rows.map((row) => benchmark(row.priceCents, row.marketMedianCents));
  const asked = marks.filter((mark) => mark?.asks).length;
  const unbenchmarked = marks.filter((mark) => mark === null).length;
  return (
    <section aria-labelledby="agent-view-heading">
      <h2 id="agent-view-heading" className="sr-only">
        How agents see your catalog
      </h2>
      <Figures>
        <Figure label="Listed for agents" tone="text-seal">
          {rows.length - hidden}
        </Figure>
        <Figure label="Hidden from agents" tone={hidden > 0 ? 'text-stop' : 'text-text'}>
          {hidden}
        </Figure>
        <Figure label="Buyers asked first on price" tone={asked > 0 ? 'text-hold' : 'text-text'}>
          {asked}
        </Figure>
        <Figure label="No market benchmark">{unbenchmarked}</Figure>
      </Figures>
      <p className="-mt-2 mb-6 text-meta text-muted">
        A listing priced more than {PRICE_ANOMALY_RATIO} times its market median makes the gate ask the buyer before their
        agent pays. Without a benchmark, the gate skips that check.
      </p>
    </section>
  );
}

export default async function SellerCatalogPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const db = appDb();
  const seller = await findSeller(db, DEMO_SELLER_SLUG);
  const rows = seller ? await sellerCatalogRows(db, seller.id) : [];

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        id="catalog-heading"
        title="Your catalog"
        purpose={
          seller
            ? `${plural(rows.length, 'listing')} at ${seller.name}, each priced beside the market median for the same product.`
            : 'Your listings, whether agents can buy them, and how each price compares with the market.'
        }
      />
      {!seller ? (
        <NotOnboarded />
      ) : rows.length > 0 ? (
        <>
          <AgentView rows={rows} />
          <CatalogGrid rows={rows} labelledBy="catalog-heading" />
        </>
      ) : (
        <EmptyState message="Your catalog has no listings yet." action={{ href: '/seller', label: 'Add listings to your shop' }} />
      )}
    </div>
  );
}
