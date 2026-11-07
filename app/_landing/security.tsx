import type { ReactNode } from 'react';
import { LineHoverLink } from '@/components/vui/line-hover-link';
import { StatsCounter } from '@/components/vui/stats-counter';
import { readSecurityStats } from './security-stats';
import { Section } from './section';

// Security: the attack replay's numbers when the replay's results are in the repository, the
// published attack it replays, a link to every layer's outcome, and the four rules the code holds
// to whatever a model or a listing says. Each claim matches lib/gate, lib/intent/apply.ts,
// lib/llm/untrusted.ts and the PayPal client's request ids.

const RULES = [
  ['The gate decides.', 'Allow, ask or block comes from plain TypeScript rules. No model can approve a purchase.'],
  ['Models only tighten.', 'The intent check can turn allow into ask or block, never the reverse. A check that cannot run sends the purchase to you.'],
  [
    'Outside text is quoted data.',
    'Listings, search results and market prices reach a model only inside quoted blocks, and a listing that addresses AI agents is hidden from them.',
  ],
  [
    'Retries never double charge.',
    'Every PayPal call that moves money carries a request id made from the purchase, so PayPal answers a repeat with the first result.',
  ],
] as const;

/** One number: the label first for a screen reader, the number first on screen. */
function Stat({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-col-reverse border-t border-line-strong pt-5">
      <dt className="mt-2 text-body text-muted">{label}</dt>
      <dd className="text-section font-medium text-text">{children}</dd>
    </div>
  );
}

export function Security() {
  const stats = readSecurityStats();

  return (
    <Section id="security" index={2} name="Security" statement={['We attacked it the way', 'agents get attacked.']}>
      {stats && (
        <dl className="mb-14 grid grid-cols-2 gap-x-6 gap-y-10 lg:mb-16 lg:grid-cols-4">
          <Stat label="Attacks replayed against every layer">
            <StatsCounter value={stats.attacks} />
          </Stat>
          {stats.live && (
            <>
              <Stat label={`Stopped in the live run against Claude, of ${stats.live.ran}`}>
                <StatsCounter value={stats.live.stopped} />
              </Stat>
              <Stat label="Model calls in the live run">
                <StatsCounter value={stats.live.calls} />
              </Stat>
              <Stat label="What the live run cost, estimated">
                <StatsCounter value={stats.live.costUsd} prefix="$" decimals={2} />
              </Stat>
            </>
          )}
        </dl>
      )}

      <div className="grid gap-12 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <p className="max-w-[46ch] text-lead text-pretty text-text">
            In January 2026, researchers showed that a few sentences in a product listing steer shopping agents built on
            Google&apos;s Agent Payments Protocol, even with a signed mandate. Behest replays that attack against each of its
            layers and publishes what each one did, including what got through.
          </p>
          <p className="mt-3 font-mono text-meta text-muted">arXiv 2601.22569</p>
          <LineHoverLink href="/security" className="mt-8 text-body">
            See every attack, layer by layer
          </LineHoverLink>
        </div>
        <ul className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:col-span-7">
          {RULES.map(([rule, detail]) => (
            <li key={rule} className="border-t border-line pt-5">
              <p className="text-lead font-medium text-text">{rule}</p>
              <p className="mt-2 text-body text-muted">{detail}</p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
