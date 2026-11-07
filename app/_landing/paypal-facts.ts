// The PayPal values the home page's bento tiles show, copied from the code that uses them so the page
// stays a light server module. tests/ui/paypal-facts.test.ts holds each list to its source, so a
// change there fails a test rather than leaving the page wrong.

import type { BadgeTone } from '@/components/ui/status-badge';

export type StatusChip = { code: string; tone: BadgeTone; meaning: string };

/**
 * Vault v3, in order: confirming the mandate creates a setup token (app/api/mandates/confirm), the
 * buyer approves it at PayPal, Behest exchanges it for a payment token (lib/paypal/vault.ts), and
 * an allowed purchase is then charged to that token's `vault_id` (lib/paypal/orders.ts).
 */
export const VAULT_SEQUENCE = [
  { step: 'Mandate signed', detail: 'setup token created' },
  { step: 'Approved at PayPal', detail: 'by the buyer, once' },
  { step: 'Wallet saved', detail: 'payment token' },
  { step: 'Charged, no click', detail: 'vault_id' },
] as const;

/** Orders v2: the capture statuses captureStatus in lib/paypal/orders.ts acts on; any other is an error. */
export const ORDER_CAPTURE_STATUSES: readonly StatusChip[] = [
  { code: 'COMPLETED', tone: 'seal', meaning: 'Captured' },
  { code: 'PENDING', tone: 'hold', meaning: 'Captured, settling' },
  { code: 'DECLINED', tone: 'stop', meaning: 'No money moved' },
];

/** Payouts: a status the poll in lib/purchases/settle.ts keeps polling, the paid one, and a failed one. */
export const PAYOUT_STATUSES: readonly StatusChip[] = [
  { code: 'PENDING', tone: 'muted', meaning: 'Polled again' },
  { code: 'SUCCESS', tone: 'seal', meaning: 'Seller paid' },
  { code: 'RETURNED', tone: 'stop', meaning: 'An operator settles it' },
];

/** Refunds: the request id lib/purchases/deliver.ts sends a refund under, after the purchase id. */
export const REFUND_REQUEST_SUFFIX = ':refund';

/** Disputes: the evidence items lib/disputes/pack.ts can put in a pack, in its order. */
export const EVIDENCE_IDS = ['mandate', 'readback', 'receipt', 'cart', 'decision', 'purchase_log', 'approval', 'tracking'] as const;

/** Webhooks: the events lib/paypal/webhook-registration.ts subscribes to, each acted on only once verified. */
export const WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
] as const;

/** Agent Toolkit: the only tools lib/paypal/toolkit-bridge.ts gives the dispute evidence agent. */
export const TOOLKIT_TOOLS = ['list_disputes', 'get_dispute', 'get_order', 'get_shipment_tracking'] as const;
