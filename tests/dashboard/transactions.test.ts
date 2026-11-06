import { describe, expect, it } from 'vitest';
import { transactionRows } from '@/lib/dashboard/transactions';
import type { Transaction } from '@/lib/paypal';

const purchases = [
  { id: 'purchase-1', paypalCaptureId: 'CAPTURE-1' },
  { id: 'purchase-2', paypalCaptureId: null },
];

function transaction(info: Partial<Transaction['transaction_info']>, email?: string): Transaction {
  return {
    transaction_info: { transaction_id: 'TX', ...info },
    ...(email && { payer_info: { email_address: email } }),
  };
}

describe('transactionRows', () => {
  it('matches a capture to its purchase and reads money as integer cents', () => {
    const [row] = transactionRows(
      [
        transaction(
          {
            transaction_id: 'CAPTURE-1',
            transaction_event_code: 'T0006',
            transaction_initiation_date: '2026-11-06T11:20:00+0000',
            transaction_amount: { value: '18.75', currency_code: 'USD' },
            fee_amount: { value: '-0.95', currency_code: 'USD' },
            transaction_status: 'S',
            transaction_note: 'Behest order',
          },
          'priya@example.com',
        ),
      ],
      purchases,
    );
    expect(row).toEqual({
      id: 'CAPTURE-1',
      date: '2026-11-06T11:20:00.000Z',
      eventCode: 'T0006',
      eventType: 'Checkout payment',
      status: 'Success',
      currency: 'USD',
      amountCents: 1875,
      feeCents: -95,
      counterparty: 'priya@example.com',
      note: 'Behest order',
      purchaseId: 'purchase-1',
      match: 'capture',
    });
  });

  it('links a refund or reversal to the purchase whose capture it references', () => {
    const [row] = transactionRows(
      [
        transaction({
          transaction_id: 'REFUND-1',
          paypal_reference_id: 'CAPTURE-1',
          transaction_event_code: 'T1107',
          transaction_amount: { value: '-18.75', currency_code: 'USD' },
        }),
      ],
      purchases,
    );
    expect(row).toMatchObject({ purchaseId: 'purchase-1', match: 'related', eventType: 'Refund', amountCents: -1875 });
  });

  it('labels payouts, and leaves anything else unmatched with its raw codes', () => {
    const rows = transactionRows(
      [
        transaction({ transaction_id: 'PAYOUT-1', transaction_event_code: 'T0001', transaction_status: 'P' }),
        transaction({ transaction_id: 'OTHER-1', transaction_event_code: 'T9999', transaction_status: 'Z' }),
      ],
      purchases,
    );
    expect(rows[0]).toMatchObject({ purchaseId: null, match: 'payout', eventType: 'Payout', status: 'Pending' });
    expect(rows[1]).toMatchObject({
      purchaseId: null,
      match: 'unmatched',
      eventType: 'T9999',
      status: 'Z',
      date: null,
      amountCents: 0,
      feeCents: 0,
      currency: null,
      counterparty: null,
      note: null,
    });
  });
});
