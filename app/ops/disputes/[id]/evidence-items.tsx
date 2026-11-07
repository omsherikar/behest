import type { DraftItem } from '@/lib/ops-pages/dispute-outcomes';

// The evidence items of a dispute's pack, each folded under its title. Their text comes from
// Behest's records and quotes what buyers, sellers and PayPal wrote, so it is shown as plain text,
// wrapped anywhere so that a long signature never widens the page.

export function EvidenceItems({ items }: { items: readonly DraftItem[] }) {
  return (
    <section aria-labelledby="evidence-heading" className="mt-8">
      <h2 id="evidence-heading" className="text-lg font-semibold text-pp-navy">
        Evidence items
      </h2>
      <p className="mt-1 text-sm text-pp-muted">
        What Behest&apos;s records show, as the narrative cites them. Open an item to read it in full.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <details className="rounded-xl border border-pp-border bg-pp-surface">
              <summary className="cursor-pointer rounded-xl p-3 font-semibold text-pp-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-blue">
                {item.title} <span className="font-mono text-xs font-normal text-pp-muted">{item.id}</span>
              </summary>
              <pre className="border-t border-pp-border p-3 font-mono text-xs whitespace-pre-wrap text-pp-ink wrap-anywhere">
                {item.body}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
