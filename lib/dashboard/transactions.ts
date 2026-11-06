import { amountOf, type Money, type Transaction } from '@/lib/paypal';

// PayPal Transaction Search rows for the operator's reconciliation view: each transaction on the
// merchant account, matched to the purchase it belongs to where one can be found.

/** How a transaction relates to Behest's purchases. */
export type TransactionMatch =
  /** The capture of a purchase's payment. */
  | 'capture'
  /** A refund, reversal or hold that references a purchase's capture. */
  | 'related'
  /** A payout to a seller. */
  | 'payout'
  | 'unmatched';

export type DashboardTransaction = {
  id: string;
  /** ISO timestamp, or null when PayPal sent none. */
  date: string | null;
  eventCode: string | null;
  eventType: string;
  status: string | null;
  currency: string | null;
  amountCents: number;
  feeCents: number;
  counterparty: string | null;
  note: string | null;
  purchaseId: string | null;
  match: TransactionMatch;
};

// Transaction event codes Behest produces, in words. Others show their raw code.
const EVENT_TYPES: Record<string, string> = {
  T0001: 'Payout',
  T0006: 'Checkout payment',
  T1105: 'Hold released',
  T1107: 'Refund',
  T1503: 'Payout hold',
};

const STATUSES: Record<string, string> = {
  S: 'Success',
  P: 'Pending',
  D: 'Denied',
  V: 'Reversed',
  F: 'Partially refunded',
};

const cents = (money?: Money) => Math.round(amountOf(money) * 100);

export function transactionRows(
  transactions: Transaction[],
  purchases: { id: string; paypalCaptureId: string | null }[],
): DashboardTransaction[] {
  const purchaseByCapture = new Map(
    purchases.flatMap((p) => (p.paypalCaptureId ? [[p.paypalCaptureId, p.id] as const] : [])),
  );

  return transactions.map(({ transaction_info: t, payer_info: payer }) => {
    const captured = purchaseByCapture.get(t.transaction_id);
    const referenced = t.paypal_reference_id ? purchaseByCapture.get(t.paypal_reference_id) : undefined;
    const code = t.transaction_event_code ?? null;
    let match: TransactionMatch = 'unmatched';
    if (captured) match = 'capture';
    else if (referenced) match = 'related';
    else if (code === 'T0001') match = 'payout';

    return {
      id: t.transaction_id,
      date: t.transaction_initiation_date ? new Date(t.transaction_initiation_date).toISOString() : null,
      eventCode: code,
      eventType: (code && EVENT_TYPES[code]) ?? code ?? 'Unknown',
      status: t.transaction_status ? (STATUSES[t.transaction_status] ?? t.transaction_status) : null,
      currency: t.transaction_amount?.currency_code ?? null,
      amountCents: cents(t.transaction_amount),
      feeCents: cents(t.fee_amount),
      counterparty: payer?.email_address ?? null,
      note: t.transaction_note ?? null,
      purchaseId: captured ?? referenced ?? null,
      match,
    };
  });
}
