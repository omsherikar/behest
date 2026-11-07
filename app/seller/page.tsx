import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { buttonClass } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { ProofFields } from '@/components/ui/proof-fields';
import { StatusBadge } from '@/components/ui/status-badge';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { plural } from '@/lib/domain/words';
import { sellerSummary, type SellerSummary } from '@/lib/seller-pages/seller';
import { Onboarding } from './onboarding';
import { requireSeller } from './require-seller';

export const metadata: Metadata = {
  title: 'Your shop',
};

// The seller's home page. The seller persona is the demo seller: until a seller with its slug
// exists, the page offers the onboarding form; after that, a summary of the shop and links to its
// catalog and orders.

export default async function SellerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const summary = await sellerSummary(appDb(), DEMO_SELLER_SLUG);

  return (
    <div className="w-full max-w-3xl">
      <PageHeader
        title="Your shop"
        purpose={
          summary
            ? 'Shopping agents buy from your catalog for their buyers. Each order arrives with a signed receipt, and Behest checks it before the order is yours.'
            : 'List your products from a CSV file, photos or both. Behest writes each listing, screens it for text aimed at AI agents and compares your prices with the market.'
        }
      />
      <Onboarding slug={DEMO_SELLER_SLUG} onboarded={summary !== null}>
        {summary && <ShopSummary summary={summary} />}
      </Onboarding>
    </div>
  );
}

function Count({ label, value, tone = 'text-text' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col justify-between gap-1">
      <dt className="text-meta text-muted">{label}</dt>
      <dd className={`font-mono text-title font-medium tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function ShopSummary({ summary }: { summary: SellerSummary }) {
  const { orders, hidden } = summary;
  const received = orders.accepted + orders.rejected;
  return (
    <div className="grid gap-5">
      <section aria-labelledby="shop-heading" className="rounded-panel border border-line bg-panel">
        <header className="border-b border-line px-4 py-3 sm:px-5">
          <h2 id="shop-heading" className="font-medium text-text">
            {summary.name}
          </h2>
        </header>
        <div className="grid gap-5 p-4 sm:p-5">
          <ProofFields
            fields={[
              { label: 'Shop slug', value: <span className="font-mono text-meta">{summary.slug}</span> },
              { label: 'Payouts go to', value: <span className="break-all">{summary.payoutEmail}</span> },
            ]}
          />
          {/* Labels at the top and values at the bottom, so the values line up when a label wraps. */}
          <dl className="grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Count label="Listings" value={summary.listings} />
            <Count label="Hidden from agents" value={hidden.length} tone={hidden.length > 0 ? 'text-stop' : 'text-text'} />
            <Count label="Orders" value={received} />
          </dl>
          <p className="text-body text-muted">
            {received === 0
              ? 'No agent has placed an order with you yet.'
              : `${plural(orders.accepted, 'order')} accepted, ${orders.rejected} rejected because the receipt did not check out.`}
          </p>
          <div className="flex flex-wrap gap-3">
            <Link href="/seller/catalog" className={buttonClass('primary')}>
              See your catalog
            </Link>
            <Link href="/seller/orders" className={buttonClass('secondary')}>
              See your orders
            </Link>
          </div>
        </div>
      </section>

      {hidden.length > 0 && (
        <section aria-labelledby="hidden-heading" className="rounded-panel border border-line bg-panel p-4 sm:p-5">
          <h2 id="hidden-heading" className="font-medium text-text">
            Hidden from agents
          </h2>
          <p className="mt-1 text-body text-muted">Shopping agents cannot see or buy these listings.</p>
          <ul className="mt-3 grid gap-2">
            {hidden.map((listing) => (
              <li key={listing.sku} className="grid gap-1.5 rounded-control border border-stop/30 bg-stop/6 p-3">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="stop" label="For agents">
                    Hidden from agents
                  </StatusBadge>
                  <span className="font-mono text-meta text-muted">{listing.sku}</span>
                  <span className="text-body text-text">{listing.title}</span>
                </span>
                <span className="text-body text-stop">{listing.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
