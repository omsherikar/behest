import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { MandatePanel } from '@/components/purchase/mandate-panel';
import { buttonClass } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { appDb, demoBuyerId } from '@/lib/app-deps';
import { mandateInForce } from '@/lib/buyer-pages/mandate';
import { type LedgerRow, ledgerRows } from '@/lib/buyer-pages/purchases';
import { statusWords } from '@/lib/buyer-pages/words';
import { requireBuyer } from '../require-buyer';
import { ShopRun } from './shop-run';

export const metadata: Metadata = {
  title: 'Shop',
};

// The buyer sends the shopping agent out with a request and watches what it does, in a console
// eight columns wide, beside the mandate it shops under and the last few purchases it proposed. Each
// purchase it proposes is checked against that mandate: paid at once, asked of the buyer, or blocked.
// On a phone the mandate comes first, then the request, then the recent purchases. Seller names may
// be a seller's text.

const RECENT = 4;

function RecentPurchases({ rows }: { rows: LedgerRow[] }) {
  return (
    <section aria-labelledby="recent-heading" className="panel rounded-frame p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="recent-heading" className="text-heading font-medium text-text">
          Recent purchases
        </h2>
        {rows.length > 0 && (
          <Link href="/buyer/ledger" className={buttonClass('quiet', 'small', '-mr-3.5')}>
            Ledger
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-body text-muted">Nothing yet. What your agent proposes appears here and in your ledger.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {rows.slice(0, RECENT).map((row) => (
            <li key={row.id} className="grid gap-1.5 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-body text-text">{row.seller}</span>
                <Money cents={row.totalCents} mono className="shrink-0 text-meta text-text" />
              </div>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <VerdictBadge verdict={row.verdict} />
                <span className="text-meta text-muted">{statusWords(row.status)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function ShopPage() {
  // Reads the mandate and the purchases on every request, never at build time.
  await connection();
  await requireBuyer();

  const db = appDb();
  const buyerId = await demoBuyerId(db);
  const [mandate, recent] = await Promise.all([mandateInForce(db, buyerId, new Date()), ledgerRows(db, buyerId)]);

  return (
    <>
      <PageHeader
        title="Shop"
        purpose="Ask your agent for something and watch each purchase it proposes get checked against your mandate."
        actions={
          <Link href="/buyer/ledger" className={buttonClass('secondary')}>
            Open your ledger
          </Link>
        }
      />
      {/* Source order is the phone's: the mandate, the console, then recent purchases. */}
      <div className="grid gap-x-6 gap-y-6 lg:grid-cols-12 lg:grid-rows-[auto_1fr] xl:gap-x-8">
        <aside aria-label="Your mandate" className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-start-1 lg:self-start">
          <MandatePanel mandate={mandate} />
        </aside>
        <div className="min-w-0 lg:col-span-8 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <ShopRun />
        </div>
        <aside aria-label="Recent purchases" className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-start-2 lg:self-start">
          <RecentPurchases rows={recent} />
        </aside>
      </div>
    </>
  );
}
