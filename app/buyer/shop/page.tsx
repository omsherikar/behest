import type { Metadata } from 'next';
import { connection } from 'next/server';
import { MandatePanel } from '@/components/purchase/mandate-panel';
import { PageHeader } from '@/components/ui/page-header';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { mandateInForce } from '@/lib/buyer-pages/mandate';
import { requireBuyer } from '../require-buyer';
import { ShopRun } from './shop-run';

export const metadata: Metadata = {
  title: 'Shop',
};

// The buyer sends the shopping agent out with a request and watches what it does, beside the
// mandate it shops under. Each purchase it proposes is checked against that mandate: paid at once,
// asked of the buyer, or blocked. On a phone the mandate comes first, above the request.

export default async function ShopPage() {
  // Reads the mandate on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const mandate = await mandateInForce(db, await demoBuyerId(db), new Date());

  return (
    <div className="w-full">
      <PageHeader
        title="Shop"
        purpose="Ask your agent for something and watch each purchase it proposes get checked against your mandate, step by step."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8">
        <aside aria-label="Your mandate" className="lg:sticky lg:top-28 lg:col-start-2 lg:row-start-1 lg:self-start">
          <MandatePanel mandate={mandate} />
        </aside>
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <ShopRun />
        </div>
      </div>
    </div>
  );
}
