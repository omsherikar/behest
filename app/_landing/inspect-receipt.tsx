import type { ReactNode } from 'react';
import { JwsView } from '@/components/ui/jws-view';
import { GlowBorderCard } from '@/components/vui/glow-border-card';
import { SAMPLE } from './sample';
import { Section } from './section';

// Inspect a receipt: the sample purchase's receipt decoded in the page's one glowing frame, beside
// the four steps a seller takes to verify one, which match lib/receipts and the verify route.

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-[0.92em] text-text">{children}</code>;

const STEPS: ReactNode[] = [
  <>
    Fetch Behest&apos;s public keys from <Code>/.well-known/jwks.json</Code>.
  </>,
  <>
    Check the Ed25519 signature with the key the header names, and that the type is <Code>behest-receipt+jws</Code>.
  </>,
  <>Compare the cart hash and the amount with the order received, and the seller with yourself.</>,
  <>
    Or post the receipt, the cart and your seller slug to <Code>/api/receipts/verify</Code>. It answers with the payload, or
    with the check that failed.
  </>,
];

export function InspectReceipt() {
  return (
    <Section
      id="receipt"
      index={4}
      name="Receipts"
      statement={['Every paid purchase', 'gets a signed receipt.']}
      lead="This is the sample purchase's receipt, decoded. A seller checks it before accepting the order; so can anyone else."
    >
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-4">
          <h3 className="text-heading font-medium text-text">How a seller verifies it</h3>
          <ol className="mt-6 grid gap-5">
            {STEPS.map((step, index) => (
              <li key={index} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 text-body text-muted">
                <span className="flex size-7 items-center justify-center rounded-lg border border-white/20 font-mono text-[0.6875rem] text-text tabular-nums">
                  {index + 1}
                </span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
          <p className="mt-8 text-meta text-muted">
            This sample was signed with a throwaway key, <Code>{SAMPLE.keyId}</Code>, so it verifies against the key set beside it
            in <Code>lib/demo/sample-receipt.json</Code>, not against the live one.
          </p>
        </div>
        <GlowBorderCard className="min-w-0 rounded-panel lg:col-span-8">
          <JwsView jws={SAMPLE.receiptJws} token="auto" />
        </GlowBorderCard>
      </div>
    </Section>
  );
}
