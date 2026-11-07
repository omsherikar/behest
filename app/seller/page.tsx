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

// The seller's home page, in two columns from 1024 px. The seller persona is the demo seller: until
// a seller with its slug exists, the page offers the onboarding form beside what Behest does with the
// listings; after that, a summary of the shop beside the listings hidden from agents.

export default async function SellerPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const summary = await sellerSummary(appDb(), DEMO_SELLER_SLUG);

  return (
    <>
      <PageHeader
        title="Your shop"
        purpose={
          summary
            ? 'Shopping agents buy from your catalog for their buyers. Each order arrives with a signed receipt, and Behest checks it before the order is yours.'
            : 'List your products from a CSV file, photos or both. Behest writes each listing, screens it for text aimed at AI agents and compares your prices with the market.'
        }
        actions={
          summary ? (
            <Link href="/seller/orders" className={buttonClass('secondary')}>
              See your orders
            </Link>
          ) : undefined
        }
      />
      <div className="grid gap-8 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <Onboarding slug={DEMO_SELLER_SLUG} onboarded={summary !== null}>
            {summary && <ShopSummary summary={summary} />}
          </Onboarding>
        </div>
        <aside aria-label={summary ? 'Hidden from agents' : 'What Behest does with your listings'} className="min-w-0 lg:sticky lg:top-28 lg:col-span-5 lg:self-start">
          {summary ? <HiddenListings hidden={summary.hidden} /> : <WhatHappens />}
        </aside>
      </div>
    </>
  );
}

/** Before onboarding: what Behest does with what the seller uploads, as lib/catalog does it. */
function WhatHappens() {
  const steps = [
    ['Writes each listing', 'A model drafts a title, a description and a category from your CSV rows and photos.'],
    ['Screens it for agents', 'A listing whose text speaks to AI agents is hidden from them and blocked at the gate.'],
    ['Compares your price', 'Each listing gets a market median from an open-web search, which the gate checks prices against.'],
  ] as const;
  return (
    <section aria-labelledby="happens-heading" className="panel rounded-frame p-5 sm:p-6">
      <h2 id="happens-heading" className="text-heading font-medium text-text">
        What Behest does with your listings
      </h2>
      <ol className="mt-5 grid gap-4">
        {steps.map(([title, detail], index) => (
          <li key={title} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3">
            <span className="flex size-7 items-center justify-center rounded-lg border border-white/20 font-mono text-[0.6875rem] text-text tabular-nums">
              {index + 1}
            </span>
            <span>
              <span className="block text-body font-medium text-text">{title}</span>
              <span className="block text-body text-muted">{detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Count({ label, value, tone = 'text-text' }: { label: string; value: number; tone?: string }) {
  return (
    // The label leads for a screen reader; the figure leads on screen.
    <div className="flex flex-col bg-surface px-5 py-4">
      <dt className="order-last mt-1 text-meta text-muted">{label}</dt>
      <dd className={`text-[1.75rem] leading-9 font-medium tracking-[-0.03em] tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function ShopSummary({ summary }: { summary: SellerSummary }) {
  const { orders, hidden } = summary;
  const received = orders.accepted + orders.rejected;
  return (
    <section aria-labelledby="shop-heading" className="panel rounded-frame">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-5 py-4 sm:px-6">
        <h2 id="shop-heading" className="text-heading font-medium text-text">
          {summary.name}
        </h2>
        <span className="font-mono text-meta text-muted">{summary.slug}</span>
      </header>
      <div className="grid gap-6 p-5 sm:p-6">
        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-panel border border-line bg-line">
          <Count label="Listings" value={summary.listings} />
          <Count label="Hidden from agents" value={hidden.length} tone={hidden.length > 0 ? 'text-stop' : 'text-text'} />
          <Count label="Orders" value={received} />
        </dl>
        <ProofFields fields={[{ label: 'Payouts go to', value: <span className="break-all">{summary.payoutEmail}</span> }]} />
        <p className="text-body text-muted">
          {received === 0
            ? 'No agent has placed an order with you yet.'
            : `${plural(orders.accepted, 'order')} accepted, ${orders.rejected} rejected because the receipt did not check out.`}
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/seller/catalog" className={buttonClass('primary')}>
            See your catalog
          </Link>
        </div>
      </div>
    </section>
  );
}

function HiddenListings({ hidden }: { hidden: SellerSummary['hidden'] }) {
  return (
    <section aria-labelledby="hidden-heading" className="panel rounded-frame p-5 sm:p-6">
      <h2 id="hidden-heading" className="text-heading font-medium text-text">
        Hidden from agents
      </h2>
      {hidden.length === 0 ? (
        <p className="mt-2 text-body text-muted">Every listing is visible to shopping agents. None of their text speaks to AI agents.</p>
      ) : (
        <>
          <p className="mt-1 text-body text-muted">Shopping agents cannot see or buy these listings.</p>
          <ul className="mt-4 grid gap-2">
            {hidden.map((listing) => (
              <li key={listing.sku} className="grid gap-1.5 rounded-panel border border-stop/30 bg-stop/6 p-4">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="stop" label="For agents">
                    Hidden from agents
                  </StatusBadge>
                  <span className="font-mono text-meta text-muted">{listing.sku}</span>
                </span>
                <span className="text-body text-text">{listing.title}</span>
                <span className="text-body text-stop">{listing.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
