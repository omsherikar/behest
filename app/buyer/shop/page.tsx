import type { Metadata } from 'next';
import { requireBuyer } from '../require-buyer';
import { ShopRun } from './shop-run';

export const metadata: Metadata = {
  title: 'Shop',
};

// The buyer sends the shopping agent out with a request and watches what it does. Each purchase it
// proposes is checked against the buyer's mandate: paid at once, asked of the buyer, or blocked.

export default async function ShopPage() {
  await requireBuyer();

  return (
    <div className="w-full max-w-2xl">
      <h1 className="text-3xl font-semibold text-pp-navy">Shop</h1>
      <p className="mt-3 text-pp-muted">
        Tell your agent what you want. It shops at Behest sellers, and Behest checks each purchase it proposes against
        your mandate: it pays for what you allowed, asks you about the rest at PayPal, and blocks what you ruled out.
      </p>
      <ShopRun />
    </div>
  );
}
