import Link from 'next/link';
import { buttonClass } from '@/components/ui/button';

/** What the catalog and orders pages show before the seller's shop is onboarded. */
export function NotOnboarded() {
  return (
    <section className="mt-6 max-w-2xl rounded-xl border border-pp-border bg-pp-surface p-5">
      <p className="font-semibold text-pp-navy">Your shop is not onboarded yet.</p>
      <p className="mt-1 text-sm text-pp-muted">List your products from a CSV file or photos, and they show up here.</p>
      <Link
        href="/seller"
        className={buttonClass('primary', 'default', 'mt-4')}
      >
        Onboard your shop
      </Link>
    </section>
  );
}
