// Checking that a webhook really came from PayPal before Behest acts on it. PayPal's
// verify-webhook-signature call is the only judge, and this fails closed: a missing signature header,
// no PAYPAL_WEBHOOK_ID, a body that is not a JSON object, an error from the call or any answer other
// than SUCCESS all mean the event is not verified. It never throws. When the call itself fails, the
// reason is logged so an outage or bad credentials can be told apart from a forged event.

import { PayPalApiError, paypalRequest } from './http';
import type { PaypalPort } from './port';

const VERIFY = '/v1/notifications/verify-webhook-signature';

/** Each field of the verification request and the PayPal header it is copied from. */
const SIGNATURE_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

/** The webhook event the body holds, or null when the body is not a JSON object. */
function parseEvent(rawBody: string): object | null {
  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return null;
  }
  return typeof event === 'object' && event !== null && !Array.isArray(event) ? event : null;
}

/**
 * Why the verification call failed, for the log: PayPal's status and debug id, or the error's name and
 * message. Never PayPal's error body, which can echo back what was sent.
 */
function describeFailure(error: unknown): string {
  if (error instanceof PayPalApiError) {
    const debugId = debugIdOf(error.body);
    return `PayPal answered ${error.status} on ${error.path}${debugId ? ` (debug_id ${debugId})` : ''}`;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function debugIdOf(body: string): string | null {
  try {
    const debugId: unknown = (JSON.parse(body) as { debug_id?: unknown } | null)?.debug_id;
    return typeof debugId === 'string' ? debugId : null;
  } catch {
    return null;
  }
}

export const verifyWebhook: PaypalPort['verifyWebhook'] = async (headers, rawBody) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;

  const signature: Record<string, string> = {};
  for (const [field, header] of Object.entries(SIGNATURE_HEADERS)) {
    const value = headers.get(header);
    if (!value) return false;
    signature[field] = value;
  }

  const event = parseEvent(rawBody);
  if (!event) return false;

  try {
    const result = await paypalRequest<{ verification_status?: unknown } | undefined>('POST', VERIFY, {
      body: { ...signature, webhook_id: webhookId, webhook_event: event },
    });
    return result?.verification_status === 'SUCCESS';
  } catch (error) {
    console.error(`Could not verify a PayPal webhook, so it is rejected: ${describeFailure(error)}`);
    return false;
  }
};
