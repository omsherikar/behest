// Saving a buyer's PayPal wallet with no purchase (Vault v3). The buyer approves a setup token while
// signing their mandate; exchanging it for a payment token lets the agent charge the wallet later
// without the buyer present.

import { paypalRequest } from './http';
import type { PaypalPort } from './port';

type Link = { href: string; rel: string };
type VaultToken = { id: string; customer: { id: string }; links?: Link[] };

export const createSetupToken: PaypalPort['createSetupToken'] = async ({ returnUrl, cancelUrl, description }) => {
  const token = await paypalRequest<VaultToken>('POST', '/v3/vault/setup-tokens', {
    body: {
      payment_source: {
        paypal: {
          description,
          usage_pattern: 'IMMEDIATE',
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: false,
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            brand_name: 'Behest',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    },
    // Fresh for each call, and reused by the helper's retries, so one call creates one setup token.
    requestId: crypto.randomUUID(),
  });

  const approveUrl = token.links?.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href;
  if (!approveUrl) throw new Error(`PayPal setup token ${token.id} has no approve link`);
  return { id: token.id, approveUrl, customerId: token.customer.id };
};

export const createPaymentToken: PaypalPort['createPaymentToken'] = async (setupTokenId) => {
  const token = await paypalRequest<VaultToken>('POST', '/v3/vault/payment-tokens', {
    body: { payment_source: { token: { id: setupTokenId, type: 'SETUP_TOKEN' } } },
    // Keyed on the setup token, so repeating the exchange returns the first payment token.
    requestId: `${setupTokenId}:payment-token`,
  });
  return { id: token.id, customerId: token.customer.id };
};
