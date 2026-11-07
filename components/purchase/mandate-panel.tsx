import Link from 'next/link';
import type { ReactNode } from 'react';
import type { MandateInForce } from '@/lib/buyer-pages/mandate';
import type { WalletStatus } from '@/lib/db/schema';
import type { BudgetPeriod } from '@/lib/domain/policy';
import { buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Money } from '@/components/ui/money';
import { ProofId } from '@/components/ui/proof-id';
import { StatusBadge, type BadgeTone } from '@/components/ui/status-badge';

// The buyer's mandate in force, as a side panel: how much of the budget is left this period, when the
// agent must ask, the most one purchase may cost, when the mandate ends and, where the page asks for
// them, the wallet that pays and the readback the buyer confirmed. Read on the server when the page
// loads; the gate decides each purchase on its own figures.

const LEFT_IN: Record<BudgetPeriod, string> = {
  day: 'left today',
  week: 'left this week',
  month: 'left this month',
  once: 'left on this mandate',
};

const WALLET: Record<WalletStatus | 'none', { tone: BadgeTone; words: string }> = {
  linked: { tone: 'seal', words: 'PayPal linked' },
  pending: { tone: 'hold', words: 'PayPal not linked yet' },
  revoked: { tone: 'stop', words: 'PayPal unlinked' },
  none: { tone: 'muted', words: 'No PayPal wallet' },
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
    // In a narrow panel the value drops under its label rather than breaking the label.
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <dt className="shrink-0 text-meta whitespace-nowrap text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-body text-text">{children}</dd>
    </div>
  );
}

export function MandatePanel({
  mandate,
  title = 'Your mandate in force',
  wallet,
  readback = false,
  change = true,
}: {
  mandate: MandateInForce | null;
  title?: string;
  /** The wallet's status, shown when the page is about the mandate itself. */
  wallet?: WalletStatus | 'none';
  /** Lists what the buyer confirmed, in the readback's words. */
  readback?: boolean;
  /** Links to the mandate page, for a panel shown elsewhere. */
  change?: boolean;
}) {
  if (!mandate) {
    return (
      <EmptyState
        className="py-10"
        message="You have no mandate in force, so your agent cannot buy anything. Write one in your own words first."
        action={change ? { href: '/buyer', label: 'Write your mandate' } : undefined}
      />
    );
  }

  const used = mandate.budgetCents === 0 ? 1 : Math.min(1, mandate.spentCents / mandate.budgetCents);
  return (
    <section aria-labelledby="in-force-heading" className="panel rounded-frame p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="in-force-heading" className="text-heading font-medium text-text">
          {title}
        </h2>
        {wallet && <StatusBadge tone={WALLET[wallet].tone}>{WALLET[wallet].words}</StatusBadge>}
      </div>

      <div className="mt-6">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <Money
            cents={mandate.leftCents}
            className={`text-[2rem] leading-10 font-medium tracking-[-0.03em] ${mandate.leftCents === 0 ? 'text-stop' : 'text-text'}`}
          />
          <span className="text-body text-muted">
            {LEFT_IN[mandate.period]} of <Money cents={mandate.budgetCents} />
          </span>
        </p>
        <div aria-hidden className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
          <div className={`h-full rounded-full ${mandate.leftCents === 0 ? 'bg-stop' : 'bg-seal'}`} style={{ width: `${(1 - used) * 100}%` }} />
        </div>
        <p className="mt-2 text-meta text-muted">
          <Money cents={mandate.spentCents} /> spent or in flight this period
        </p>
      </div>

      <dl className="mt-5 divide-y divide-line border-t border-line">
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

      {readback && (
        <div className="mt-5 border-t border-line pt-5">
          <h3 className="text-meta text-muted">What you confirmed</h3>
          <ul className="mt-2 grid gap-1.5">
            {mandate.readback.map((line) => (
              <li key={line} className="flex gap-2.5 text-body text-text">
                <span aria-hidden className="mt-2.5 size-1 shrink-0 rounded-full bg-muted" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {change && (
        <Link href="/buyer" className={buttonClass('quiet', 'small', 'mt-4 -ml-3.5')}>
          Change your mandate
        </Link>
      )}
    </section>
  );
}
