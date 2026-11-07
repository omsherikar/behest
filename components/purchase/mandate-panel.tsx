import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MandateInForce } from '@/lib/buyer-pages/mandate';
import type { BudgetPeriod } from '@/lib/domain/policy';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ProofId } from '@/components/ui/proof-id';

// The buyer's mandate in force, beside the agent on the shop page: what they confirmed, how much of
// the budget is left, when the agent must ask, and when the mandate ends. Read on the server when
// the page loads; the gate decides each purchase on its own figures.

const LEFT_IN: Record<BudgetPeriod, string> = {
  day: 'left today',
  week: 'left this week',
  month: 'left this month',
  once: 'left on this mandate',
};

/** An instant as "7 Nov 2026, 09:00 UTC". */
const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="text-body text-text">{children}</dd>
    </div>
  );
}

export function MandatePanel({ mandate }: { mandate: MandateInForce | null }) {
  if (!mandate) {
    return (
      <EmptyState
        message="You have no mandate in force, so your agent cannot buy anything. Write one in your own words first."
        action={{ href: '/buyer', label: 'Write your mandate' }}
      />
    );
  }

  const used = mandate.budgetCents === 0 ? 1 : Math.min(1, mandate.spentCents / mandate.budgetCents);
  return (
    <section aria-labelledby="in-force-heading" className="rounded-panel border border-line bg-panel p-4">
      <h2 id="in-force-heading" className="font-medium text-text">
        Your mandate in force
      </h2>
      <ul className="mt-2 grid list-disc gap-1 pl-4 text-body text-text marker:text-muted">
        {mandate.readback.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <div className="mt-4">
        <p className="text-body text-text">
          <Money cents={mandate.leftCents} className="font-medium" />{' '}
          <span className="text-muted">
            of <Money cents={mandate.budgetCents} /> {LEFT_IN[mandate.period]}
          </span>
        </p>
        <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          <div className={`h-full ${mandate.leftCents === 0 ? 'bg-stop' : 'bg-seal'}`} style={{ width: `${(1 - used) * 100}%` }} />
        </div>
      </div>

      <dl className="mt-3 divide-y divide-line">
        <Fact label="Asks you above">
          {mandate.askAboveCents === null ? 'Never on amount alone' : <Money cents={mandate.askAboveCents} />}
        </Fact>
        <Fact label="Per purchase">
          Up to <Money cents={mandate.perPurchaseMaxCents} />
        </Fact>
        <Fact label="Expires">{mandate.expiresAt ? `${dateTime.format(new Date(mandate.expiresAt))} UTC` : 'Never'}</Fact>
        <Fact label="Policy hash">
          <ProofId value={mandate.policyHash} label="Policy hash" />
        </Fact>
      </dl>

      <Link href="/buyer" className={buttonClass('quiet', 'small', 'mt-2 -ml-2.5')}>
        Change your mandate
      </Link>
    </section>
  );
}
