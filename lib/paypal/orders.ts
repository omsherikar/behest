// Taking payment with Orders v2. A purchase within the buyer's mandate charges their saved wallet
// with no buyer present. A purchase over the approval limit becomes an order the buyer approves on
// PayPal, captured once they return.
//
// Statuses are reported honestly: DECLINED only when PayPal says no money moved. Any other failure
// is rethrown untouched, because the caller must treat it as a payment that may have gone through.

import { PayPalApiError, paypalRequest } from './http';
import { toValue } from './money';
import type { PaypalPort } from './port';

const ORDERS = '/v2/checkout/orders';

type Link = { href: string; rel: string };
type Capture = { id: string; status: string };
type Order = {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: Capture[] } }[];
  links?: Link[];
};
type CaptureResult = Awaited<ReturnType<PaypalPort['captureOrder']>>;

/** COMPLETED and PENDING pass through; DECLINED, FAILED and anything else mean the buyer was not charged. */
function captureStatus(status: string): CaptureResult['status'] {
  return status === 'COMPLETED' || status === 'PENDING' ? status : 'DECLINED';
}

function readCapture(order: Order): CaptureResult {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`PayPal order ${order.id} is ${order.status} with no capture`);
  return { captureId: capture.id, status: captureStatus(capture.status) };
}

/** A 422 with INSTRUMENT_DECLINED: PayPal refused the buyer's funding, so no money moved. */
function isInstrumentDeclined(error: unknown): boolean {
  if (!(error instanceof PayPalApiError) || error.status !== 422) return false;
  try {
    const { details } = JSON.parse(error.body) as { details?: { issue?: string }[] };
    return Array.isArray(details) && details.some((detail) => detail?.issue === 'INSTRUMENT_DECLINED');
  } catch {
    return false;
  }
}

function purchaseUnit(amountCents: number, description: string, invoiceId: string) {
  return { amount: { currency_code: 'USD', value: toValue(amountCents) }, description, invoice_id: invoiceId };
}

export const chargeSavedWallet: PaypalPort['chargeSavedWallet'] = async (i) => {
  let order: Order;
  try {
    order = await paypalRequest<Order>('POST', ORDERS, {
      body: {
        intent: 'CAPTURE',
        purchase_units: [purchaseUnit(i.amountCents, i.description, i.invoiceId)],
        payment_source: { paypal: { vault_id: i.paymentTokenId } },
      },
      requestId: i.requestId,
    });
  } catch (error) {
    if (isInstrumentDeclined(error)) return { orderId: '', captureId: '', status: 'DECLINED' };
    throw error;
  }

  // PayPal normally captures a saved-wallet order as it creates it. When it only approves the order,
  // the capture is keyed on the charge's request id, so repeating the charge repeats this capture too.
  if (order.status === 'APPROVED' || order.status === 'CREATED') {
    return { orderId: order.id, ...(await captureOrder(order.id, `${i.requestId}-capture`)) };
  }
  return { orderId: order.id, ...readCapture(order) };
};

export const createApprovalOrder: PaypalPort['createApprovalOrder'] = async (i) => {
  const order = await paypalRequest<Order>('POST', ORDERS, {
    body: {
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit(i.amountCents, i.description, i.invoiceId)],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: i.returnUrl,
            cancel_url: i.cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            brand_name: 'Behest',
          },
        },
      },
    },
    requestId: i.requestId,
  });

  const links = order.links ?? [];
  const approveUrl = (links.find((link) => link.rel === 'payer-action') ?? links.find((link) => link.rel === 'approve'))?.href;
  if (!approveUrl) throw new Error(`PayPal order ${order.id} has no link for the buyer to approve it`);
  return { orderId: order.id, approveUrl };
};

export const captureOrder: PaypalPort['captureOrder'] = async (orderId, requestId) => {
  let order: Order;
  try {
    // An empty JSON body, as the sandbox proof sent it.
    order = await paypalRequest<Order>('POST', `${ORDERS}/${orderId}/capture`, { body: {}, requestId });
  } catch (error) {
    if (isInstrumentDeclined(error)) return { captureId: '', status: 'DECLINED' };
    throw error;
  }
  return readCapture(order);
};
