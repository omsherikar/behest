// Refunding a buyer from Behest's capture, for example when the seller rejects the order. The caller's
// request id makes a repeated refund return the first one rather than refund twice. PayPal errors are
// rethrown untouched, and the refund's status is PayPal's own string.

import { paypalRequest } from './http';
import { toValue } from './money';
import type { PaypalPort } from './port';

type Refund = { id?: string; status?: string };

export const refundCapture: PaypalPort['refundCapture'] = async ({ captureId, amountCents, note, requestId }) => {
  const refund = await paypalRequest<Refund | undefined>('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    body: { amount: { value: toValue(amountCents), currency_code: 'USD' }, note_to_payer: note },
    requestId,
  });
  if (!refund?.id || !refund.status) {
    throw new Error(`PayPal answered the refund of capture ${captureId} with no refund id or status, so money may have moved`);
  }
  return { refundId: refund.id, status: refund.status };
};
