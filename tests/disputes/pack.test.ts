import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { disputes, mandates, purchases, receipts } from '@/lib/db/schema';
import { assembleEvidencePack, type EvidencePack } from '@/lib/disputes/pack';
import { chargeAllowed } from '@/lib/purchases/charge';
import { appendEvent } from '@/lib/purchases/events';
import { issueReceipt } from '@/lib/purchases/receipt';
import { setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://behest.example.com/');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Opens a PayPal dispute against the purchase and returns its id. */
async function openDispute(db: Db, purchaseId: string | null): Promise<string> {
  const [row] = await db
    .insert(disputes)
    .values({
      paypalDisputeId: 'PP-D-1001',
      purchaseId,
      captureId: 'CAPTURE-1',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      status: 'OPEN',
      amountCents: 1875,
      buyerNotes: 'I never asked for this.',
    })
    .returning({ id: disputes.id });
  return row.id;
}

/** A purchase the policy allowed, charged through the real purchase flow, under dispute. */
async function chargedDispute() {
  const s = await setUp();
  await chargeAllowed(s.deps, s.purchaseId);
  return { ...s, disputeId: await openDispute(s.db, s.purchaseId) };
}

/** A purchase the buyer approved at PayPal, captured and receipted, under dispute. */
async function approvedDispute() {
  const s = await setUpCaptured('ASK');
  await s.db
    .update(purchases)
    .set({ gateVerdict: 'ASK', gateReasons: ['$18.75 is above the $25.00 ask threshold.'] })
    .where(eq(purchases.id, s.purchaseId));
  await appendEvent(s.db, s.purchaseId, 'status', { from: 'proposed', to: 'awaiting_approval' });
  await appendEvent(s.db, s.purchaseId, 'status', { from: 'awaiting_approval', to: 'captured' });
  await issueReceipt(s.deps, s.purchaseId);
  return { ...s, disputeId: await openDispute(s.db, s.purchaseId) };
}

function itemOf(pack: EvidencePack, id: string) {
  const item = pack.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`the pack has no ${id} item`);
  return item;
}

describe('assembleEvidencePack', () => {
  it('builds the pack of a charged purchase from its signed records', async () => {
    const { db, purchaseId, mandateId, disputeId } = await chargedDispute();
    const [mandate] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
    const [receipt] = await db.select().from(receipts).where(eq(receipts.purchaseId, purchaseId));

    const pack = await assembleEvidencePack(db, disputeId);

    expect(pack.disputeId).toBe(disputeId);
    expect(pack.purchaseId).toBe(purchaseId);
    expect(pack.items.map((item) => item.id)).toEqual(['mandate', 'readback', 'receipt', 'cart', 'purchase_log']);
    for (const item of pack.items) expect(item.title).not.toBe('');

    const mandateBody = itemOf(pack, 'mandate').body;
    expect(mandateBody).toContain(mandate.id);
    expect(mandateBody).toContain('$60 a month on groceries and spices');
    expect(mandateBody).toContain(mandate.jws);

    expect(itemOf(pack, 'readback').body).toContain('Up to $60.00 a month.');

    const receiptBody = itemOf(pack, 'receipt').body;
    expect(receiptBody).toContain(receipt.id);
    expect(receiptBody).toContain(receipt.jws);
    expect(receiptBody).toContain('https://behest.example.com/api/receipts/verify');

    const cartBody = itemOf(pack, 'cart').body;
    expect(cartBody).toContain('2 x Turmeric, 100 g');
    expect(cartBody).toContain('$9.75');
    expect(cartBody).toContain('$18.75');
  });

  it('lists the purchase events in the order they were recorded', async () => {
    const { db, purchaseId, disputeId } = await chargedDispute();
    const kinds = (await eventsOf(db, purchaseId)).map((event) => event.kind);

    const log = itemOf(await assembleEvidencePack(db, disputeId), 'purchase_log').body;

    const steps = log.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(steps).toHaveLength(kinds.length);
    steps.forEach((line, index) => {
      expect(line).toMatch(new RegExp(`^${index + 1}\\. \\S+Z ${kinds[index]}( |$)`));
    });
    expect(steps[0]).toContain('"from":"proposed"');
    expect(steps[0]).toContain('"to":"charging"');
  });

  it('never puts a payment token id, a wallet id or the buyer id in the pack', async () => {
    const { db, purchaseId, buyerId, disputeId } = await chargedDispute();
    // The charge event carries the payment token it was sent with.
    expect((await eventsOf(db, purchaseId)).find((event) => event.kind === 'charge')?.data).toHaveProperty(
      'paymentTokenId',
      'TOKEN-1',
    );

    const text = JSON.stringify(await assembleEvidencePack(db, disputeId));

    expect(text).not.toContain('TOKEN-1');
    expect(text).not.toContain('CUSTOMER-1');
    expect(text).not.toContain(buyerId);
    expect(text).not.toContain('paymentTokenId');
  });

  it('redacts a wallet id that a logged PayPal error repeats', async () => {
    const { db, purchaseId, disputeId } = await chargedDispute();
    await appendEvent(db, purchaseId, 'charge_unknown', {
      error: 'PayPal 422 on /v2/checkout/orders: {"details":[{"field":"/payment_source/token/id","value":"TOKEN-1"}]}',
    });

    const log = itemOf(await assembleEvidencePack(db, disputeId), 'purchase_log').body;

    expect(log).not.toContain('TOKEN-1');
    expect(log).toContain('"value\\":\\"[redacted]\\"');
  });

  it('has no approval item for a purchase the policy allowed', async () => {
    const { db, disputeId } = await chargedDispute();

    const pack = await assembleEvidencePack(db, disputeId);

    expect(pack.items.map((item) => item.id)).not.toContain('approval');
  });

  it('has an approval item for a purchase the buyer was asked to approve', async () => {
    const { db, disputeId } = await approvedDispute();

    const pack = await assembleEvidencePack(db, disputeId);

    expect(pack.items.map((item) => item.id)).toEqual(['mandate', 'readback', 'receipt', 'cart', 'purchase_log', 'approval']);
    const approval = itemOf(pack, 'approval').body;
    expect(approval).toContain('Approved by: the buyer');
    expect(approval).toContain('$18.75 is above the $25.00 ask threshold.');
    expect(approval).toContain('proposed to awaiting_approval');
    expect(approval).toContain('awaiting_approval to captured');
  });

  it('leaves out the receipt of a purchase that was never given one', async () => {
    const s = await setUpCaptured();
    const disputeId = await openDispute(s.db, s.purchaseId);

    const pack = await assembleEvidencePack(s.db, disputeId);

    expect(pack.items.map((item) => item.id)).toEqual(['mandate', 'readback', 'cart', 'purchase_log']);
  });

  it('throws for a dispute not yet matched to a purchase', async () => {
    const db = await createTestDb();
    const disputeId = await openDispute(db, null);

    await expect(assembleEvidencePack(db, disputeId)).rejects.toThrow(`dispute ${disputeId} is not matched to a purchase`);
  });

  it('throws for a dispute that does not exist', async () => {
    const db = await createTestDb();
    const disputeId = crypto.randomUUID();

    await expect(assembleEvidencePack(db, disputeId)).rejects.toThrow(`there is no dispute ${disputeId}`);
  });

  it('needs APP_URL for the receipt verification link', async () => {
    const { db, disputeId } = await chargedDispute();
    vi.stubEnv('APP_URL', '');

    await expect(assembleEvidencePack(db, disputeId)).rejects.toThrow('APP_URL must be set');
  });
});
