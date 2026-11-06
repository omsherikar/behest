// Paying sellers with PayPal Payouts. Behest is the merchant of record, so a buyer's payment lands in
// Behest's account and each accepted order is paid on to its seller as a one-item payout batch.
//
// The sender batch id is the payout's idempotency key: it is sent as PayPal-Request-Id too, so a call
// repeated after a lost response returns the original batch. A sender batch id PayPal has already
// used surfaces as PayoutAlreadyExists, never as a second payout. Statuses are PayPal's own strings.

import { PayPalApiError, paypalRequest } from './http';
import { toValue } from './money';
import type { PaypalPort } from './port';

const PAYOUTS = '/v1/payments/payouts';

type PayoutBatch = {
  batch_header?: { payout_batch_id?: string; batch_status?: string };
  items?: { transaction_status?: string }[];
};
type PayoutErrorBody = { name?: unknown; details?: unknown; links?: unknown };

/** PayPal already has a batch under this sender batch id, so the payout must not be sent again. */
export class PayoutAlreadyExists extends Error {
  constructor(
    readonly senderBatchId: string,
    /** The batch PayPal links from its error, or null when no batch link was found on the detail or at the top level. */
    readonly payoutBatchId: string | null,
    options?: ErrorOptions,
  ) {
    super(`PayPal already has a payout batch for sender batch id ${senderBatchId}`, options);
    this.name = 'PayoutAlreadyExists';
  }
}

/**
 * The body of a 4xx saying the sender batch id was used in the last 30 days: a USER_BUSINESS_ERROR
 * whose details name the sender batch id. Null for any other error.
 */
function duplicateBatchBody(error: unknown): PayoutErrorBody | null {
  if (!(error instanceof PayPalApiError) || error.status < 400 || error.status >= 500) return null;
  let body: PayoutErrorBody | null;
  try {
    body = JSON.parse(error.body) as PayoutErrorBody | null;
  } catch {
    return null;
  }
  if (body?.name !== 'USER_BUSINESS_ERROR' || !Array.isArray(body.details)) return null;
  return body.details.some(namesSenderBatch) ? body : null;
}

function namesSenderBatch(detail: { field?: unknown } | null | undefined): boolean {
  return typeof detail?.field === 'string' && /(^|\.)sender_batch_id$/i.test(detail.field);
}

/** A link field holds an array of links or a single link. */
function asLinks(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/**
 * The batch that already has the sender batch id. PayPal links it from the error detail naming the
 * sender batch id (seen in the sandbox: `details[].link`, an array); top-level `links` is the fallback.
 */
function linkedBatchId(body: PayoutErrorBody): string | null {
  const details: { link?: unknown }[] = Array.isArray(body.details) ? body.details.filter(namesSenderBatch) : [];
  for (const link of [...details.flatMap((detail) => asLinks(detail.link)), ...asLinks(body.links)]) {
    const href = (link as { href?: unknown } | null)?.href;
    const match = typeof href === 'string' ? /\/v1\/payments\/payouts\/([^/?#]+)/.exec(href) : null;
    if (match) return match[1];
  }
  return null;
}

export const createPayout: PaypalPort['createPayout'] = async ({ receiverEmail, amountCents, note, senderBatchId }) => {
  let payout: PayoutBatch | undefined;
  try {
    payout = await paypalRequest<PayoutBatch | undefined>('POST', PAYOUTS, {
      body: {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: 'You have a Behest payout' },
        items: [
          {
            recipient_type: 'EMAIL',
            amount: { value: toValue(amountCents), currency: 'USD' },
            receiver: receiverEmail,
            note,
            sender_item_id: senderBatchId,
          },
        ],
      },
      requestId: senderBatchId,
    });
  } catch (error) {
    const duplicate = duplicateBatchBody(error);
    if (duplicate) throw new PayoutAlreadyExists(senderBatchId, linkedBatchId(duplicate), { cause: error });
    throw error;
  }

  const payoutBatchId = payout?.batch_header?.payout_batch_id;
  if (!payoutBatchId) throw new Error(`PayPal answered payout ${senderBatchId} with no payout batch id, so it may have been created`);
  return { payoutBatchId };
};

export const getPayoutBatch: PaypalPort['getPayoutBatch'] = async (payoutBatchId) => {
  const batch = await paypalRequest<PayoutBatch | undefined>('GET', `${PAYOUTS}/${encodeURIComponent(payoutBatchId)}`);
  const batchStatus = batch?.batch_header?.batch_status;
  if (!batchStatus) throw new Error(`PayPal payout batch ${payoutBatchId} came back with no status`);
  return { batchStatus, itemStatus: batch?.items?.[0]?.transaction_status ?? null };
};
