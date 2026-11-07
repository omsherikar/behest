import { Money } from '@/components/ui/money';
import { RuleResults } from '@/components/ui/rule-results';
import { VerdictBadge } from '@/components/ui/verdict-badge';
import { FeatureCard } from '@/components/vui/feature-card';
import type { Verdict } from '@/lib/domain/verdict';
import { applyIntent } from '@/lib/intent/apply';
import type { IntentResult } from '@/lib/intent/types';
import { splitJws } from '@/lib/ui/jws';
import { forbiddenCartOutcome, SAMPLE, SAMPLE_READBACK } from './sample';
import { Section } from './section';

// How a purchase is authorized: five numbered cards, because the five steps are a sequence. Each card
// shows its step working, from the real code: the readback the code renders for the sample policy,
// the gate's own rule results, the intent check's tightening as applyIntent computes it, the approval
// a held purchase waits for, and the sample receipt's three segments.

const miniPanel = 'w-full rounded-panel border border-line bg-raised/60 p-4';

function MandateMini() {
  // The budget, the approval limit, the categories and the one exclusion: the lines a buyer reads first.
  const lines = [SAMPLE_READBACK[0], SAMPLE_READBACK[2], SAMPLE_READBACK[3], SAMPLE_READBACK[4]];
  return (
    <div className={miniPanel}>
      <p className="text-meta text-muted">You write</p>
      <p className="mt-1 text-body text-text">&ldquo;$60 a month on groceries and spices, ask me above $25, never electronics&rdquo;</p>
      <div className="my-3.5 h-px bg-line" />
      <p className="text-meta text-muted">Behest reads it back</p>
      <ul className="mt-1.5 grid gap-1">
        {lines.map((line) => (
          <li key={line} className="flex gap-2 text-meta text-text">
            <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted" />
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GateMini() {
  const pass = SAMPLE.outcomes.find((outcome) => outcome.rule === 'budget_remaining');
  const ask = SAMPLE.outcomes.find((outcome) => outcome.result === 'ask');
  const results = [pass, ask, forbiddenCartOutcome()].filter((outcome) => outcome !== undefined);
  return (
    <div className={miniPanel}>
      <RuleResults results={results} label="Three of the gate's rule results" />
    </div>
  );
}

const TIGHTENING: { gate: Verdict; check: IntentResult['verdict'] }[] = [
  { gate: 'ALLOW', check: 'consistent' },
  { gate: 'ALLOW', check: 'needs_human' },
  { gate: 'ASK', check: 'inconsistent' },
];

function IntentMini() {
  return (
    <ul className={`${miniPanel} grid gap-4`}>
      {TIGHTENING.map(({ gate, check }) => (
        <li key={`${gate}-${check}`}>
          <span className="flex flex-wrap items-center gap-2">
            <VerdictBadge verdict={gate} personal={false} />
            <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 text-muted">
              <path d="M2.5 8h10m-3.5-3.5L12.5 8 9 11.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="sr-only">becomes</span>
            <VerdictBadge verdict={applyIntent(gate, { verdict: check, reasons: [] })} personal={false} />
          </span>
          <span className="mt-1.5 block font-mono text-[0.75rem] text-muted">when the check finds {check}</span>
        </li>
      ))}
    </ul>
  );
}

function PayPalMini() {
  const ask = SAMPLE.outcomes.find((outcome) => outcome.result === 'ask');
  return (
    <div className="grid w-full gap-3 sm:grid-cols-2">
      <div className={miniPanel}>
        <VerdictBadge verdict="ALLOW" />
        <p className="mt-3 text-body text-text">Charged to your saved PayPal wallet</p>
        <p className="mt-1 text-meta text-muted">No click from you, inside the mandate.</p>
      </div>
      <div className={miniPanel}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-body text-text">{SAMPLE.item.title}</span>
          <Money cents={SAMPLE.receipt.cart.totalCents} className="text-body text-text" />
        </div>
        {ask?.detail && <p className="mt-1 text-meta text-muted">{ask.detail}</p>}
        {/* A picture of the buyer's button, not a button: the real one is on the approvals page. */}
        <span aria-hidden className="mt-4 flex h-9 w-full items-center justify-center rounded-full bg-text text-meta font-medium text-on-fill">
          Approve at PayPal
        </span>
      </div>
    </div>
  );
}

function ReceiptMini() {
  const parts = splitJws(SAMPLE.receiptJws);
  if (!parts) return null;
  const segments = [
    { name: 'Header', text: parts.header, colour: 'text-jws-header', swatch: 'bg-jws-header' },
    { name: 'Payload', text: `${parts.payload.slice(0, 44)}...${parts.payload.slice(-12)}`, colour: 'text-jws-payload', swatch: 'bg-jws-payload' },
    { name: 'Signature', text: parts.signature, colour: 'text-jws-signature', swatch: 'bg-jws-signature' },
  ];
  return (
    <div className={miniPanel}>
      <p className="font-mono text-meta leading-5 break-all">
        {segments.map(({ name, text, colour }, index) => (
          <span key={name}>
            {index > 0 && <span className="text-muted">.</span>}
            <span className={colour}>{text}</span>
          </span>
        ))}
      </p>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted">
        {segments.map(({ name, swatch }) => (
          <li key={name} className="flex items-center gap-1.5">
            <span aria-hidden className={`size-2 rounded-[2px] ${swatch}`} />
            {name}
          </li>
        ))}
        <li className="font-mono">EdDSA, key {SAMPLE.keyId}</li>
      </ul>
    </div>
  );
}

const STEPS = [
  {
    title: 'Mandate',
    visual: <MandateMini />,
    description: 'You say what your agent may buy in plain words. Code reads the policy back to you, and Behest signs it when you confirm.',
  },
  {
    title: 'Gate',
    visual: <GateMini />,
    description: 'Twelve deterministic rules check every cart against the signed policy. No model takes part.',
  },
  {
    title: 'Intent check',
    visual: <IntentMini />,
    description: 'Claude compares the cart with what you asked for. It can move a verdict toward you, never away.',
  },
  {
    title: 'PayPal',
    visual: <PayPalMini />,
    description: 'An allowed purchase is charged to your saved PayPal wallet. One that needs you waits until you approve it at PayPal.',
  },
  {
    title: 'Receipt',
    visual: <ReceiptMini />,
    description: 'Behest signs an Ed25519 receipt binding the mandate, the cart, every rule result and the capture. The seller verifies it.',
  },
] as const;

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      index={1}
      name="How it works"
      statement={['Every purchase takes five steps.', 'Each one leaves proof.']}
    >
      <ol className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        {STEPS.map((step, index) => (
          <FeatureCard
            key={step.title}
            as="li"
            index={index + 1}
            title={step.title}
            description={step.description}
            className={index < 3 ? 'lg:col-span-2' : `lg:col-span-3 ${index === 4 ? 'md:col-span-2' : ''}`}
          >
            {step.visual}
          </FeatureCard>
        ))}
      </ol>
    </Section>
  );
}
