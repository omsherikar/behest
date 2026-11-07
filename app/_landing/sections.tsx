import type { ReactNode } from 'react';
import { JwsView } from '@/components/ui/jws-view';
import { PersonaPicker } from '../persona-picker';
import { DOCS, SOURCE_URL, sourceLink } from './links';
import { SAMPLE } from './sample';

// The home page below the hero. Every claim here matches the code it describes: the gate's rules
// (lib/gate), the intent check (lib/intent/apply.ts), the PayPal client (lib/paypal), the quoting
// of outside text (lib/llm/untrusted.ts) and the receipt routes.

function Section({ id, title, lead, children }: { id: string; title: string; lead: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-14 border-t border-line">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-14 sm:px-6 lg:py-20">
        <h2 id={`${id}-title`} className="text-title font-semibold text-text">
          {title}
        </h2>
        <p className="mt-1 max-w-[65ch] text-body text-muted">{lead}</p>
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

const Code = ({ children }: { children: ReactNode }) => (
  <code className="font-mono text-[0.92em] whitespace-nowrap text-text">{children}</code>
);

export function Problem() {
  const points = [
    ['An agent spends your money.', 'It searches, compares and pays in seconds, often while you are not watching.'],
    [
      'A chat log is not proof of what you allowed.',
      'When a purchase is disputed, a transcript shows what was said, not what you authorized or what was checked.',
    ],
    [
      'A seller cannot tell an authorized order from an injected one.',
      'Text in a listing or a search result can steer an agent, and the order it places looks the same either way.',
    ],
  ] as const;
  return (
    <Section id="problem" title="Why a transcript is not enough" lead="Agents can already pay. What they were allowed to pay for is still your word against theirs.">
      <ul className="grid gap-6 md:grid-cols-3 md:gap-8">
        {points.map(([point, detail]) => (
          <li key={point} className="border-t border-line-strong/50 pt-4">
            <p className="font-medium text-text">{point}</p>
            <p className="mt-1.5 text-body text-muted">{detail}</p>
          </li>
        ))}
      </ul>
      <div className="mt-10 max-w-[75ch] border-l-2 border-line-strong pl-4 sm:pl-5">
        <p className="text-lead font-medium text-text">
          Behest is the layer that makes an agent&apos;s authorization hold up in a dispute, not only at checkout.
        </p>
        <p className="mt-2 text-body text-muted">
          Google&apos;s AP2 standard, which PayPal supports, also uses signed mandates. Behest adds what is enforced: a
          deterministic gate that checks every purchase against the mandate, resistance to instructions injected through
          listings and search results, and dispute evidence drawn from the same signed records.
        </p>
      </div>
    </Section>
  );
}

const STEPS = [
  {
    name: 'Mandate',
    does: 'You write what your agent may buy in plain words. Behest compiles it into a policy, reads it back to you and signs it when you confirm.',
    proves: 'What you allowed, in words you read back and confirmed.',
  },
  {
    name: 'Gate',
    does: 'Twelve deterministic rules check the cart against the policy, from whether the mandate is still active to whether a PayPal wallet is linked. No model takes part.',
    proves: 'Which rules passed, asked you or blocked, recorded for every purchase.',
  },
  {
    name: 'Intent check',
    does: 'Claude compares the cart with what you asked for. It can only tighten the gate’s verdict: an allowed purchase can become one that asks you or is blocked, never the reverse.',
    proves: 'The purchase matches your request, not only your limits.',
  },
  {
    name: 'PayPal',
    does: 'An allowed purchase is charged to your saved PayPal wallet. One that needs you waits until you approve it at PayPal.',
    proves: 'The money moved through PayPal, or you approved it there yourself.',
  },
  {
    name: 'Receipt',
    does: 'Behest signs a receipt with Ed25519 that binds the mandate, the cart hash, every rule result and the PayPal capture. The seller verifies it before accepting the order.',
    proves: 'This exact order was authorized and paid.',
  },
] as const;

export function HowItWorks() {
  return (
    <Section id="how-it-works" title="How a purchase is authorized" lead="Five steps, in order. Each one leaves a record you can check.">
      <ol className="grid">
        {STEPS.map((step, index) => (
          <li key={step.name} className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 pb-8 last:pb-0 lg:grid-cols-[2rem_11rem_minmax(0,1fr)_minmax(0,1fr)] lg:gap-x-8">
            {index < STEPS.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-0.5 bg-line" />}
            <span className="flex size-8 items-center justify-center rounded-full border border-line-strong bg-bg font-mono text-meta text-text tabular-nums">
              {index + 1}
            </span>
            <h3 className="self-center font-medium text-text lg:self-start lg:pt-1.5">{step.name}</h3>
            <p className="col-start-2 mt-1 text-body text-muted lg:col-start-3 lg:mt-0 lg:pt-1">{step.does}</p>
            <p className="col-start-2 mt-2 text-body text-text lg:col-start-4 lg:mt-0 lg:pt-1">
              <span className="mr-2 text-meta text-muted">Proves</span>
              {step.proves}
            </p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function InspectReceipt() {
  return (
    <Section id="receipt" title="Inspect a receipt" lead="Every paid purchase gets one. This is the sample purchase's receipt, decoded.">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-10">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <h3 className="font-medium text-text">How a seller verifies it</h3>
          <ol className="mt-3 grid list-decimal gap-3 pl-5 text-body text-muted marker:font-mono marker:text-meta marker:text-muted">
            <li>
              Fetch Behest&apos;s public keys from <Code>/.well-known/jwks.json</Code>.
            </li>
            <li>
              Check the Ed25519 signature with the key the header names, and that the type is <Code>behest-receipt+jws</Code>.
            </li>
            <li>Compare the cart hash and the amount with the order received, and the seller with yourself.</li>
            <li>
              Or post the receipt, the cart and your seller slug to <Code>/api/receipts/verify</Code>. It answers with the
              payload, or with the check that failed.
            </li>
          </ol>
          <p className="mt-5 text-meta text-muted">
            This sample was signed with a throwaway key (<Code>{SAMPLE.keyId}</Code>), so it verifies against the key set
            published beside it in <Code>lib/demo/sample-receipt.json</Code>, not against the live one.
          </p>
        </div>
        <JwsView jws={SAMPLE.receiptJws} token="auto" />
      </div>
    </Section>
  );
}

const PAYPAL_APIS = [
  ['Vault v3', '/v3/vault/payment-tokens', 'Saves the buyer’s PayPal wallet once, so an allowed purchase is charged without sending them to PayPal.'],
  ['Orders v2', '/v2/checkout/orders', 'Creates and captures every order: charged with the saved wallet when allowed, approved by the buyer at PayPal when held.'],
  ['Payouts', '/v1/payments/payouts', 'Pays the seller for each order they accept.'],
  ['Refunds', '/v2/payments/captures/{id}/refund', 'Returns the buyer’s money when a seller rejects an order whose receipt did not check out.'],
  ['Disputes', '/v1/customer/disputes', 'Reads the disputes buyers open and answers each one with evidence drawn from the signed records.'],
  ['Webhooks', '/v1/notifications/verify-webhook-signature', 'Checks the signature of every PayPal event before Behest acts on it.'],
  ['Agent Toolkit', '@paypal/agent-toolkit', 'Gives the dispute evidence agent tools that read disputes, orders and shipment tracking, and nothing else.'],
] as const;

export function BuiltOnPayPal() {
  return (
    <Section id="paypal" title="Built on PayPal" lead="Behest is the merchant of record and runs on these PayPal APIs, in the sandbox.">
      <dl className="grid divide-y divide-line border-y border-line">
        {PAYPAL_APIS.map(([name, path, use]) => (
          <div key={name} className="grid gap-x-8 gap-y-1 py-4 md:grid-cols-[11rem_minmax(0,1fr)] lg:grid-cols-[11rem_minmax(0,22rem)_minmax(0,1fr)]">
            <dt className="font-medium text-text">{name}</dt>
            <dd className="font-mono text-meta break-all text-muted md:col-start-2 lg:pt-0.5">{path}</dd>
            <dd className="text-body text-muted md:col-start-2 lg:col-start-3 lg:row-start-1">{use}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

const SAFETY = [
  ['The gate decides.', 'Allow, ask or block comes from plain TypeScript rules. No model can approve a purchase.'],
  [
    'Models only tighten.',
    'The intent check can turn allow into ask or block, never the reverse. A check that cannot run sends the purchase to you.',
  ],
  [
    'Outside text is quoted data.',
    'Listings, search results and market prices reach a model only inside escaped, quoted blocks, and a listing that addresses AI agents is hidden from them.',
  ],
  [
    'Retries never double charge.',
    'Every PayPal call that changes something carries a request id made from the purchase, so PayPal answers a repeat with the first result.',
  ],
] as const;

export function SafetyModel() {
  return (
    <Section id="safety" title="Safety model" lead="What the code holds to, whatever a model or a listing says.">
      <ul className="grid gap-6 sm:grid-cols-2 sm:gap-x-10 sm:gap-y-8">
        {SAFETY.map(([rule, detail]) => (
          <li key={rule} className="border-t border-line-strong/50 pt-4">
            <p className="font-medium text-text">{rule}</p>
            <p className="mt-1.5 text-body text-muted">{detail}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TryIt() {
  return (
    <Section id="try" title="Try it" lead="Pick a role and use the demo. Everything runs against the PayPal sandbox.">
      <div className="max-w-2xl">
        <PersonaPicker />
      </div>
    </Section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid w-full max-w-[1200px] gap-6 px-4 py-10 text-meta text-muted sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
        <div>
          <p className="font-mono text-body font-semibold text-text">behest</p>
          <p className="mt-2">PayPal sandbox only; no real money moves.</p>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <p className="font-medium text-text">Docs</p>
            <ul className="mt-2 grid gap-1">
              {DOCS.map(({ label, path }) => {
                const href = sourceLink(path);
                return (
                  <li key={path}>
                    {href ? (
                      <a href={href} className="hover:text-text">
                        {label}
                      </a>
                    ) : (
                      <>
                        {label} <Code>{path}</Code>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="font-medium text-text">Source</p>
            <p className="mt-2">
              {SOURCE_URL ? (
                <a href={SOURCE_URL} className="hover:text-text">
                  GitHub
                </a>
              ) : (
                'In the repository, private for now'
              )}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
