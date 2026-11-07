import type { Metadata } from 'next';
import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { plural } from '@/lib/domain/words';
import { sellerOrderRows } from '@/lib/seller-pages/orders';
import { findSeller } from '@/lib/seller-pages/seller';
import { NotOnboarded } from '../not-onboarded';
import { requireSeller } from '../require-seller';
import { OrdersGrid } from './orders-grid';
import { fillWindow } from '@/components/shell/app-shell';

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

  return (
    <div className={fillWindow}>
      <h1 id="orders-heading" className="text-[28px] font-semibold text-pp-navy">
        Your orders
      </h1>
      {seller ? (
        <>
          <p className="mt-2 max-w-3xl text-sm text-pp-muted">
            {plural(rows.length, 'order')} from shopping agents, {accepted} accepted. Each order arrives with a receipt
            Behest signed when the buyer&apos;s payment went through. The receipt is checked against the cart you
            received, and an order whose receipt is forged, reused, expired or for a different cart is rejected. Behest
            pays you for each accepted order through PayPal.
          </p>
          {rows.length > 0 ? (
            <div className="mt-4 flex min-h-0 flex-1 flex-col">
              <OrdersGrid rows={rows} labelledBy="orders-heading" />
            </div>
          ) : (
            <p className="mt-6 text-pp-muted">No agent has placed an order with you yet.</p>
          )}
        </>
      ) : (
        <NotOnboarded />
      )}
    </div>
  );
}
