import { FaqAccordion, type FaqItem } from '@/components/vui/faq-accordion';
import { Section } from './section';

// Questions a careful reader asks before letting an agent pay, answered as the code and the README's
// known limitations answer them: docs/architecture.md (money flow, model failures, passkeys),
// lib/receipts, and README "Known limitations".

const ITEMS: FaqItem[] = [
  {
    question: 'Does Behest hold my money?',
    answer:
      'Only in passing. A saved PayPal wallet can only pay the business that saved it, so Behest is the merchant of record: each purchase is paid into Behest’s PayPal account, and Behest pays the seller through Payouts once the seller verifies the receipt and accepts the order, or refunds you if they reject it. This demo runs on the PayPal sandbox, so no real money moves.',
  },
  {
    question: 'What does signing with a passkey add?',
    answer:
      'Without one, your signed-in session confirms the mandate. With one, your passkey signs the mandate’s policy and readback hashes with you present, and the signed mandate names that passkey and its public key, so anyone can check the signature from the mandate alone, without trusting Behest.',
  },
  {
    question: 'What happens if the model is down?',
    answer:
      'Nothing is bought that you did not allow. The gate is plain code and needs no model. If the intent check cannot run, or hits its spending cap, the purchase comes to you for approval. If the shopping agent cannot run, it stops and buys nothing, and if the mandate compiler fails, nothing is signed.',
  },
  {
    question: 'Can a seller fake a receipt?',
    answer:
      'No. Receipts are signed with Behest’s Ed25519 key, which no seller has, and the signature covers the cart hash, the amount, the seller and every rule result. Change any of it and the signature no longer verifies against the public keys at /.well-known/jwks.json. Each receipt is also accepted once, so a replay is refused.',
  },
  {
    question: 'How is this different from a signed mandate alone?',
    answer:
      'Google’s AP2 standard, which PayPal supports, also signs mandates. A signature records what you allowed; it does not stop an agent being talked into something inside it. Behest adds a deterministic gate that checks every purchase against the mandate, keeps listing text away from the model as quoted data, and turns the same signed records into dispute evidence.',
  },
  {
    question: 'What is not covered?',
    answer: (
      <>
        A listing that tells agents to choose it, at a price the mandate allows, is only partly covered. A listing&apos;s category is
        written by a model from seller text, so a dishonest seller can list earbuds as spices. Spend caps are checked, not
        reserved. There is one signing key, not yet rotated. The README lists every known limitation.
      </>
    ),
  },
];

export function Faq() {
  return (
    <Section id="faq" index={5} name="FAQ" statement={['Fair questions.', 'Straight answers.']} split>
      <FaqAccordion items={ITEMS} />
    </Section>
  );
}
