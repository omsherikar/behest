import Link from 'next/link';

/** What the catalog and orders pages show before the seller's shop is onboarded. */
export function NotOnboarded() {
  return (
    <section className="mt-6 max-w-2xl rounded-xl border border-pp-border bg-pp-surface p-5">
      <p className="font-semibold text-pp-navy">Your shop is not onboarded yet.</p>
      <p className="mt-1 text-sm text-pp-muted">List your products from a CSV file or photos, and they show up here.</p>
      <Link
        href="/seller"
        className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-pp-blue px-5 font-semibold text-on-fill transition-colors hover:bg-pp-blue-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue"
      >
        Onboard your shop
      </Link>
    </section>
  );
}
