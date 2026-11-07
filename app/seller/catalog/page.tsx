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
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { PRICE_ANOMALY_RATIO } from '@/lib/gate/rules';
import { benchmark } from '@/lib/seller-pages/benchmark';
import type { CatalogRow } from '@/lib/seller-pages/catalog';

export const metadata: Metadata = {
  title: 'Your catalog',
};

// The seller's listings in a grid nine columns wide, beside how shopping agents see them: how many
// are listed, hidden, priced far enough above the market that buyers are asked first, or without a
// benchmark, counted from the same rows the grid shows, with the price rule the gate applies.

function AgentView({ rows }: { rows: CatalogRow[] }) {
  const hidden = rows.filter((row) => row.hiddenReason !== null).length;
  const marks = rows.map((row) => benchmark(row.priceCents, row.marketMedianCents));
  const asked = marks.filter((mark) => mark?.asks).length;
  const unbenchmarked = marks.filter((mark) => mark === null).length;
  const facts: [string, number, 'seal' | 'stop' | 'hold' | 'muted'][] = [
    ['Listed for agents', rows.length - hidden, 'seal'],
    ['Hidden from agents', hidden, hidden > 0 ? 'stop' : 'muted'],
    ['Buyers asked first on price', asked, asked > 0 ? 'hold' : 'muted'],
    ['No market benchmark', unbenchmarked, 'muted'],
  ];
  return (
    <section aria-labelledby="agent-view-heading" className="panel rounded-frame p-5 sm:p-6">
      <h2 id="agent-view-heading" className="text-heading font-medium text-text">
        How agents see it
      </h2>
      <dl className="mt-4 divide-y divide-line border-y border-line">
        {facts.map(([label, count, tone]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-2.5">
            <dt className="text-body text-muted">{label}</dt>
            <dd>
              <StatusBadge tone={tone}>
                <span className="font-mono tabular-nums">{count}</span>
              </StatusBadge>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-meta text-muted">
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
        <div className="grid gap-8 lg:grid-cols-12 lg:gap-x-6 xl:gap-x-8">
          <div className="min-w-0 lg:col-span-9">
            <CatalogGrid rows={rows} labelledBy="catalog-heading" />
          </div>
          <aside aria-label="How agents see your catalog" className="min-w-0 lg:sticky lg:top-28 lg:col-span-3 lg:self-start">
            <AgentView rows={rows} />
          </aside>
        </div>
      ) : (
        <EmptyState message="Your catalog has no listings yet." action={{ href: '/seller', label: 'Add listings to your shop' }} />
      )}
    </div>
  );
}
