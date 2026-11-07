import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { sellerOrderRows } from '@/lib/seller-pages/orders';
import { findSeller } from '@/lib/seller-pages/seller';
import { NotOnboarded } from '../not-onboarded';
import { requireSeller } from '../require-seller';
import { OrdersGrid } from './orders-grid';
import { EmptyState } from '@/components/ui/empty-state';
import { Figure, Figures } from '@/components/ui/figures';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = {
  title: 'Your orders',
};

// Every order an agent placed with the seller, with the result of checking the receipt it came with.
// The seller sees what it was sold and what it is paid, never the buyer's request or mandate.

export default async function SellerOrdersPage() {
  // Reads the database on every request, never at build time.
  await connection();
  await requireSeller();

  const db = appDb();
  const seller = await findSeller(db, DEMO_SELLER_SLUG);
  const rows = seller ? await sellerOrderRows(db, seller.id) : [];
  const accepted = rows.filter((row) => row.status === 'accepted').length;
  const paidOut = rows.filter((row) => row.payoutState === 'paid').length;

  return (
    <div className="flex flex-1 flex-col">
      <PageHeader
        id="orders-heading"
        title="Your orders"
        purpose={
          seller
            ? 'Each order came with a receipt Behest signed, checked against the cart you received. Select one to inspect its receipt.'
            : 'The orders agents place with you, each with the receipt Behest signed for it.'
        }
      />
      {!seller ? (
        <NotOnboarded />
      ) : rows.length > 0 ? (
        <>
          <Figures>
            <Figure label="Orders from agents">{rows.length}</Figure>
            <Figure label="Accepted, receipt verified" tone="text-seal">
              {accepted}
            </Figure>
            <Figure label="Refused, receipt did not check out" tone={rows.length - accepted > 0 ? 'text-stop' : 'text-text'}>
              {rows.length - accepted}
            </Figure>
            <Figure label="Paid out to you">{paidOut}</Figure>
          </Figures>
          <OrdersGrid rows={rows} labelledBy="orders-heading" sellerSlug={seller.slug} />
        </>
      ) : (
        <EmptyState
          message="No agent has placed an order with you yet. Orders appear here with their receipts once agents buy from your catalog."
          action={{ href: '/seller/catalog', label: 'See your catalog' }}
        />
      )}
    </div>
  );
}
