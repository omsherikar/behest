import { ArrowRight, ArrowUUpLeft, Bank, Scales, ShoppingCartSimple, Toolbox, Vault, WebhooksLogo } from '@phosphor-icons/react/ssr';
import type { ReactNode } from 'react';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { FeatureCard } from '@/components/vui/feature-card';
import { shortId } from '@/lib/ui/format';
import {
  EVIDENCE_IDS,
  ORDER_CAPTURE_STATUSES,
  PAYOUT_STATUSES,
  REFUND_REQUEST_SUFFIX,
  type StatusChip,
  TOOLKIT_TOOLS,
  VAULT_TOKENS,
  WEBHOOK_EVENT_TYPES,
} from './paypal-facts';
import { SAMPLE } from './sample';
import { Section } from './section';

// What Behest uses PayPal for, as a bento grid: one tile per API, with its path, a small view of the
// values Behest handles there and one line on what it does with them. The values come from the code
// (./paypal-facts.ts, held to it by a test) or from the sample purchase's signed receipt. The two wide
// tiles are the saved wallet and the webhooks, whose ten events need the room.

const chip = 'rounded-full border border-line bg-raised/70 px-2.5 py-0.5 font-mono text-[0.75rem] text-text';

function Chips({ items, label }: { items: readonly string[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-wrap justify-center gap-1.5">
      {items.map((item) => (
        <li key={item} className={chip}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function Statuses({ items, label }: { items: readonly StatusChip[]; label: string }) {
  return (
    <ul aria-label={label} className="grid w-full max-w-xs gap-2.5">
      {items.map(({ code, tone, meaning }) => (
        <li key={code} className="flex items-center justify-between gap-3">
          <StatusBadge tone={tone}>
            <span className="font-mono">{code}</span>
          </StatusBadge>
          <span className="text-right text-meta text-muted">{meaning}</span>
        </li>
      ))}
    </ul>
  );
}

function RefundRequest() {
  const { payment, decision } = SAMPLE.receipt;
  return (
    <div className="grid w-full max-w-xs gap-2.5 text-center">
      <p className="flex flex-wrap items-center justify-center gap-1.5">
        <span className={chip}>
          refund <Money cents={payment.amountCents} />
        </span>
        <span className="text-meta text-muted">of</span>
        <span className={chip}>capture {shortId(payment.captureId, 4, 4)}</span>
      </p>
      <p className="font-mono text-[0.75rem] text-muted">
        request id {decision.purchaseId.slice(0, 8)}...{REFUND_REQUEST_SUFFIX}
      </p>
      <p className="text-meta text-muted">The request as it would go for the sample purchase</p>
    </div>
  );
}

function Webhooks() {
  return (
    <div className="grid justify-items-center gap-3">
      <StatusBadge tone="seal">Signature verified</StatusBadge>
      <Chips items={WEBHOOK_EVENT_TYPES} label="The PayPal events Behest acts on" />
    </div>
  );
}

const TILES: { name: string; path: string; use: string; icon: ReactNode; span?: string; visual: ReactNode }[] = [
  {
    name: 'Vault v3 saved wallets',
    path: '/v3/vault/payment-tokens',
    use: 'The buyer saves their PayPal wallet once, with no purchase, while signing the mandate. Allowed purchases charge it with no click.',
    icon: <Vault weight="regular" />,
    span: 'md:col-span-2',
    visual: (
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className={chip}>{VAULT_TOKENS[0]}</span>
        <ArrowRight aria-label="becomes a" className="size-4 text-muted" />
        <span className={chip}>{VAULT_TOKENS[1]}</span>
      </div>
    ),
  },
  {
    name: 'Orders v2',
    path: '/v2/checkout/orders',
    use: 'Creates and captures every order: charged to the saved wallet when allowed, approved by the buyer at PayPal when held.',
    icon: <ShoppingCartSimple weight="regular" />,
    visual: <Statuses items={ORDER_CAPTURE_STATUSES} label="Capture statuses Behest acts on" />,
  },
  {
    name: 'Payouts',
    path: '/v1/payments/payouts',
    use: 'Pays the seller once it has verified the receipt and accepted the order, and polls the payout until PayPal settles it.',
    icon: <Bank weight="regular" />,
    visual: <Statuses items={PAYOUT_STATUSES} label="Payout statuses Behest polls for" />,
  },
  {
    name: 'Refunds',
    path: '/v2/payments/captures/{id}/refund',
    use: 'Refunds the buyer from Behest’s capture when a seller rejects the order, once, under the purchase’s own request id.',
    icon: <ArrowUUpLeft weight="regular" />,
    visual: <RefundRequest />,
  },
  {
    name: 'Disputes with evidence',
    path: '/v1/customer/disputes',
    use: 'Matches each dispute to its purchase and answers it with the operator’s reviewed narrative, citing these evidence items.',
    icon: <Scales weight="regular" />,
    visual: <Chips items={EVIDENCE_IDS} label="Evidence items a pack can hold" />,
  },
  {
    name: 'Webhooks',
    path: '/v1/notifications/verify-webhook-signature',
    use: 'Acts on an order, capture, refund, payout or dispute event only after PayPal confirms its signature.',
    icon: <WebhooksLogo weight="regular" />,
    // Wide only in three columns, where its ten events need the room; in two, it pairs with the toolkit.
    span: 'lg:col-span-2',
    visual: <Webhooks />,
  },
  {
    name: 'Agent Toolkit, read only',
    path: '@paypal/agent-toolkit',
    use: 'Gives the dispute evidence agent these four tools and no other.',
    icon: <Toolbox weight="regular" />,
    visual: <Chips items={TOOLKIT_TOOLS} label="The toolkit tools the agent can call" />,
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
            className={tile.span}
            visualClassName="min-h-40 py-6"
          >
            {tile.visual}
          </FeatureCard>
        ))}
      </ul>
    </Section>
  );
}
