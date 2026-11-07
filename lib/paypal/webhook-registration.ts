// Points the sandbox REST app's webhook at a deployment. PayPal keeps one webhook per URL, so the
// first run for a URL creates it and every later run gives it the current event types. The id it
// returns is what PAYPAL_WEBHOOK_ID must hold for incoming events to pass verification.

import { randomUUID } from 'node:crypto';
import { paypalRequest } from './http';

const WEBHOOKS = '/v1/notifications/webhooks';

/** The PayPal events Behest acts on. */
export const WEBHOOK_EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
] as const;

/** Where PayPal sends events for the app served at `origin`, which must be https: PayPal delivers to nothing else. */
export function webhookUrl(origin: string): string {
  const url = URL.parse(origin);
  if (url?.protocol !== 'https:') {
    throw new Error('APP_URL must be an https origin, because PayPal delivers webhooks over https only');
  }
  return new URL('/api/paypal/webhooks', url.origin).href;
}

type Webhook = { id: string; url: string };

/** The webhook's id, and whether this run created it rather than updating it. */
export type WebhookRegistration = { id: string; created: boolean };

/** Creates the webhook for `url` with every event type, or gives them to the one that already exists. */
export async function registerWebhook(url: string): Promise<WebhookRegistration> {
  const eventTypes = WEBHOOK_EVENT_TYPES.map((name) => ({ name }));
  const { webhooks = [] } = await paypalRequest<{ webhooks?: Webhook[] }>('GET', WEBHOOKS);
  const existing = webhooks.find((webhook) => webhook.url === url);

  // Each write carries a fresh request id, so a retry inside this run is applied at most once.
  if (existing) {
    await paypalRequest('PATCH', `${WEBHOOKS}/${encodeURIComponent(existing.id)}`, {
      body: [{ op: 'replace', path: '/event_types', value: eventTypes }],
      requestId: randomUUID(),
    });
    return { id: existing.id, created: false };
  }
  const created = await paypalRequest<Webhook>('POST', WEBHOOKS, {
    body: { url, event_types: eventTypes },
    requestId: randomUUID(),
  });
  return { id: created.id, created: true };
}
