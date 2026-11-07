import { ArrowRight, ArrowUUpLeft, Bank, Scales, ShoppingCartSimple, Toolbox, Vault, WebhooksLogo } from '@phosphor-icons/react/ssr';
import type { ReactNode } from 'react';
import { FeatureCard } from '@/components/vui/feature-card';
import { Section } from './section';

// What Behest uses PayPal for, as a bento grid: one tile per API, with its path and one line on what
// Behest does with it, from lib/paypal. The two wide tiles show the parts a reader asks about: the
// two tokens behind a saved wallet, and the only toolkit tools the dispute agent can call.

const chip = 'rounded-full border border-line bg-raised/70 px-3 py-1 font-mono text-meta text-text';

/** `wide` tiles span two columns: from 768 px, or from 1024 px only where a narrower grid would leave a gap. */
const TILES: { name: string; path: string; use: string; icon: ReactNode; wide?: boolean; wideFrom?: 'lg'; visual?: ReactNode }[] = [
  {
    name: 'Vault v3 saved wallets',
    path: '/v3/vault/payment-tokens',
    use: 'The buyer saves their PayPal wallet once, with no purchase, while signing the mandate. Allowed purchases charge it with no click.',
    icon: <Vault weight="regular" />,
    wide: true,
    visual: (
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className={chip}>setup token</span>
        <ArrowRight aria-hidden className="size-4 text-muted" />
        <span className={chip}>payment token</span>
      </div>
    ),
  },
  {
    name: 'Orders v2',
    path: '/v2/checkout/orders',
    use: 'Creates and captures every order: charged to the saved wallet when allowed, approved by the buyer at PayPal when held.',
    icon: <ShoppingCartSimple weight="regular" />,
  },
  {
    name: 'Payouts',
    path: '/v1/payments/payouts',
    use: 'Pays the seller once it has verified the receipt and accepted the order.',
    icon: <Bank weight="regular" />,
  },
  {
    name: 'Refunds',
    path: '/v2/payments/captures/{id}/refund',
    use: 'Refunds the buyer from Behest’s capture when a seller rejects the order.',
    icon: <ArrowUUpLeft weight="regular" />,
  },
  {
    name: 'Disputes with evidence',
    path: '/v1/customer/disputes',
    use: 'Matches each dispute to its purchase and answers it with the operator’s reviewed, cited narrative.',
    icon: <Scales weight="regular" />,
  },
  {
    name: 'Webhooks',
    path: '/v1/notifications/verify-webhook-signature',
    use: 'Accepts an order, capture, refund, payout or dispute event only after PayPal confirms its signature.',
    icon: <WebhooksLogo weight="regular" />,
  },
  {
    name: 'Agent Toolkit, read only',
    path: '@paypal/agent-toolkit',
    use: 'Gives the dispute evidence agent these four tools and no other.',
    icon: <Toolbox weight="regular" />,
    wide: true,
    wideFrom: 'lg',
    visual: (
      <ul className="flex flex-wrap justify-center gap-2">
        {['list_disputes', 'get_dispute', 'get_order', 'get_shipment_tracking'].map((tool) => (
          <li key={tool} className={chip}>
            {tool}
          </li>
        ))}
      </ul>
    ),
  },
];

export function BuiltOnPayPal() {
  return (
    <Section
      id="paypal"
      index={3}
      name="Built on PayPal"
      statement={['Every step that moves money', 'runs through PayPal.']}
      lead="Behest is the merchant of record: a saved wallet can only pay the business that saved it, so Behest takes the payment and pays the seller out."
    >
      <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => (
          <FeatureCard
            key={tile.name}
            as="li"
            title={tile.name}
            icon={tile.icon}
            meta={tile.path}
            description={tile.use}
            className={tile.wide ? (tile.wideFrom === 'lg' ? 'lg:col-span-2' : 'md:col-span-2') : undefined}
            visualClassName="min-h-0 py-5"
          >
            {tile.visual}
          </FeatureCard>
        ))}
      </ul>
    </Section>
  );
}
