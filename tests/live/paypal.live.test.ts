// An opt-in check that the PayPal client still reads what the PayPal sandbox sends. The unit tests run
// the client against recorded fixtures; this suite runs it against the sandbox itself, so a change in
// PayPal's response shapes shows up here first. It is skipped unless PAYPAL_LIVE=1, so `npm test`
// never reaches the network. It reads PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYEE_EMAIL, and
// pays PAYEE_EMAIL one cent of sandbox money per run:
//
//   PAYPAL_LIVE=1 npx vitest run tests/live --testTimeout=120000

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { listDisputes } from '@/lib/paypal/disputes';
import { resetPaypalTokenCacheForTests } from '@/lib/paypal/http';
import { PayoutAlreadyExists, createPayout, getPayoutBatch } from '@/lib/paypal/payouts';
import { createSetupToken } from '@/lib/paypal/vault';

/** PayPal's payout batch statuses. */
const BATCH_STATUSES = ['DENIED', 'PENDING', 'PROCESSING', 'SUCCESS', 'CANCELED'];
/** PayPal's payout item statuses. */
const ITEM_STATUSES = ['SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED', 'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED'];

const POLL_FOR_MS = 60_000;
const POLL_EVERY_MS = 5_000;

function payeeEmail(): string {
  const email = process.env.PAYEE_EMAIL;
  if (!email) throw new Error('PAYEE_EMAIL must be set to a sandbox account that can receive payouts');
  return email;
}

/** Reads the batch until its item has left PENDING, or until the polling time runs out. */
async function settledPayoutBatch(payoutBatchId: string): Promise<Awaited<ReturnType<typeof getPayoutBatch>>> {
  const deadline = Date.now() + POLL_FOR_MS;
  for (;;) {
    const batch = await getPayoutBatch(payoutBatchId);
    if ((batch.itemStatus !== null && batch.itemStatus !== 'PENDING') || Date.now() >= deadline) return batch;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
}

describe.skipIf(process.env.PAYPAL_LIVE !== '1')('the PayPal client against the sandbox', () => {
  it('creates a setup token the buyer can approve on the sandbox', async () => {
    const token = await createSetupToken({
      returnUrl: 'https://example.com/behest/mandate/approved',
      cancelUrl: 'https://example.com/behest/mandate/cancelled',
      description: 'Let my shopping agent pay within my mandate',
    });

    expect(token).toEqual({ id: expect.any(String), approveUrl: expect.any(String), customerId: expect.any(String) });
    expect(token.id).not.toBe('');
    expect(token.customerId).not.toBe('');
    const approve = new URL(token.approveUrl);
    expect(approve.protocol).toBe('https:');
    expect(approve.hostname).toMatch(/(^|\.)sandbox\.paypal\.com$/);
    console.info(`Approve the setup token at ${token.approveUrl}`);
  });

  it('lists disputes as summaries', async () => {
    const disputes = await listDisputes();

    expect(Array.isArray(disputes)).toBe(true);
    for (const dispute of disputes) {
      expect(dispute).toEqual({
        id: expect.any(String),
        status: expect.any(String),
        reason: expect.any(String),
        amountCents: expect.any(Number),
        captureId: dispute.captureId === null ? null : expect.any(String),
        createTime: expect.any(String),
      });
      expect(Number.isSafeInteger(dispute.amountCents)).toBe(true);
      expect(Number.isNaN(Date.parse(dispute.createTime))).toBe(false);
    }
  });

  describe('a one-cent payout', () => {
    const senderBatchId = `live-check:${randomUUID()}`;
    const payout = () => ({ receiverEmail: payeeEmail(), amountCents: 1, note: 'Behest live sandbox check', senderBatchId });
    let payoutBatchId: string | undefined;

    it('is created and leaves PENDING with a known status', async () => {
      ({ payoutBatchId } = await createPayout(payout()));
      expect(payoutBatchId).toMatch(/^\w+$/);

      const batch = await settledPayoutBatch(payoutBatchId);

      expect(BATCH_STATUSES).toContain(batch.batchStatus);
      expect(ITEM_STATUSES).toContain(batch.itemStatus);
      expect(batch.itemStatus).not.toBe('PENDING');
    });

    // PayPal answers a repeated sender batch id with its duplicate error, even though the request id
    // repeats too: it does not replay the first answer, whichever OAuth token the repeat carries.
    it('is refused when sent again on the same OAuth token, naming the existing batch', async () => {
      if (!payoutBatchId) throw new Error('the payout was not created, so there is nothing to send again');

      const error = await createPayout(payout()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PayoutAlreadyExists);
      expect(error).toMatchObject({ senderBatchId, payoutBatchId });
    });

    it('is refused when sent again from a new process with a fresh OAuth token, naming the existing batch', async () => {
      if (!payoutBatchId) throw new Error('the payout was not created, so there is nothing to send again');
      resetPaypalTokenCacheForTests();

      const error = await createPayout(payout()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PayoutAlreadyExists);
      expect(error).toMatchObject({ senderBatchId, payoutBatchId });
    });
  });
});
