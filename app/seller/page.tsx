import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { plural } from '@/lib/domain/words';
import { sellerSummary, type SellerSummary } from '@/lib/seller-pages/seller';
import { Onboarding } from './onboarding';
import { requireSeller } from './require-seller';
import { SellerNav } from './seller-nav';

export const metadata: Metadata = {
  title: 'Your shop',
};

// The seller's home page. The seller persona is the demo seller: until a seller with its slug
// exists, the page offers the onboarding form; after that, a summary of the shop and links to its
// catalog and orders.

const primaryLink =
  'inline-flex h-10 items-center justify-center rounded-full bg-pp-blue px-5 font-semibold text-white transition-colors hover:bg-pp-blue-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';
const secondaryLink =
  'inline-flex h-10 items-center justify-center rounded-full border border-pp-blue px-5 font-semibold text-pp-blue transition-colors hover:bg-pp-highlight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue';

export default async function SellerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const summary = await sellerSummary(appDb(), DEMO_SELLER_SLUG);

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10 font-paypal text-pp-ink sm:py-16">
      <SellerNav current="/seller" />
      <h1 className="mt-6 text-3xl font-semibold text-pp-navy">Your shop</h1>
      <p className="mt-3 text-pp-muted">
        {summary
          ? "Shopping agents buy from your catalog for their buyers. Each order arrives with a signed receipt, and Behest checks it before the order is yours."
          : 'List your products from a CSV file, photos or both. Behest writes each listing, screens it for text aimed at AI agents and compares your prices with the market.'}
      </p>
      <Onboarding slug={DEMO_SELLER_SLUG} onboarded={summary !== null}>
        {summary && <ShopSummary summary={summary} />}
      </Onboarding>
    </main>
  );
}

function ShopSummary({ summary }: { summary: SellerSummary }) {
  const { orders, hidden } = summary;
  return (
    <section aria-labelledby="shop-heading" className="mt-8 rounded-xl border border-pp-border bg-pp-surface p-5">
      <h2 id="shop-heading" className="text-lg font-semibold text-pp-navy">
        {summary.name}
      </h2>
      <p className="mt-1 text-sm text-pp-muted">
        Slug <span className="font-mono text-pp-ink">{summary.slug}</span>
      </p>
      <p className="text-sm break-words text-pp-muted">Payouts go to {summary.payoutEmail}</p>

      {/* Labels at the top and values at the bottom, so the values line up when a label wraps. */}
      <dl className="mt-5 grid grid-cols-3 gap-3">
        <div className="flex flex-col justify-between">
          <dt className="text-sm text-pp-muted">Listings</dt>
          <dd className="text-2xl font-semibold text-pp-navy">{summary.listings}</dd>
        </div>
        <div className="flex flex-col justify-between">
          <dt className="text-sm text-pp-muted">Hidden from agents</dt>
          <dd className={`text-2xl font-semibold ${hidden.length > 0 ? 'text-pp-danger' : 'text-pp-navy'}`}>{hidden.length}</dd>
        </div>
        <div className="flex flex-col justify-between">
          <dt className="text-sm text-pp-muted">Orders</dt>
          <dd className="text-2xl font-semibold text-pp-navy">{orders.accepted + orders.rejected}</dd>
        </div>
      </dl>
      <p className="mt-2 text-sm text-pp-muted">
        {orders.accepted + orders.rejected === 0
          ? 'No agent has placed an order with you yet.'
          : `${plural(orders.accepted, 'order')} accepted, ${orders.rejected} rejected because the receipt did not check out.`}
      </p>

      {hidden.length > 0 && (
        <div className="mt-5">
          <h3 className="font-semibold text-pp-navy">Hidden from agents</h3>
          <p className="mt-1 text-sm text-pp-muted">Shopping agents cannot see or buy these listings.</p>
          <ul className="mt-2 flex flex-col gap-2">
            {hidden.map((listing) => (
              <li key={listing.sku} className="rounded-lg border border-pp-danger/40 p-3 text-sm">
                <span className="font-mono font-semibold text-pp-ink">{listing.sku}</span>{' '}
                <span className="text-pp-ink">{listing.title}</span>
                <span className="mt-1 block text-pp-danger">{listing.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/seller/catalog" className={primaryLink}>
          See your catalog
        </Link>
        <Link href="/seller/orders" className={secondaryLink}>
          See your orders
        </Link>
      </div>
    </section>
  );
}
