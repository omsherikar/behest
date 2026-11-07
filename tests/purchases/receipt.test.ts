import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { purchases, receipts } from '@/lib/db/schema';
import type { DecisionRecord } from '@/lib/domain/decision';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { issueReceipt } from '@/lib/purchases/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { verifyJws } from '@/lib/receipts/sign';
import { jwks, key, NOW, PASSED, setUp, setUpCaptured } from '@/tests/helpers/purchase-deps';
import { eventsOf, SEEDED_SELLER, seededCart } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

/** What the seeded mandate row stores. */
const MANDATE_JWS = 'mandate.jws.value';
const SEEDED_HASH = 'a'.repeat(64);

describe('issueReceipt', () => {
  it('signs a receipt of the captured payment that strict-parses, with a whole-second iat and a Z capture time', async () => {
    const { db, deps, purchaseId, mandateId, orderId, captureId } = await setUpCaptured();

    const { receiptId, jws } = await issueReceipt(deps, purchaseId);

    const payload = await verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload);
    expect(payload).toEqual({
      v: 1,
      id: receiptId,
      iss: 'behest',
      iat: Math.floor(NOW.getTime() / 1000),
      mandate: { id: mandateId, policyHash: SEEDED_HASH, jwsHash: sha256Hex(MANDATE_JWS) },
      seller: { slug: SEEDED_SELLER.slug },
      cart: { hash: hashOf(seededCart), totalCents: seededCart.totalCents, currency: 'USD', itemCount: 3 },
      decision: {
        purchaseId,
        verdict: 'ALLOW',
        approver: 'policy',
        rulesetVersion: 'gate-v1',
        outcomes: PASSED.map(({ rule, result }) => ({ rule, result })),
      },
      payment: {
        processor: 'paypal',
        orderId,
        captureId,
        amountCents: seededCart.totalCents,
        capturedAt: '2026-11-06T11:59:58.125Z',
      },
    });
    expect(Number.isInteger(payload.iat)).toBe(true);
    expect(await db.select().from(receipts)).toEqual([
      expect.objectContaining({ id: receiptId, purchaseId, jws, payloadHash: hashOf(payload), keyId: key.kid }),
    ]);
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'receipt', data: { receiptId } }]);
  });

  it("carries the hash of the agent's decision record when the purchase has one", async () => {
    const { db, deps, purchaseId } = await setUpCaptured();
    const decision: DecisionRecord = {
      v: 1,
      runId: 'run-1',
      steps: [{ tool: 'search_sellers', input: { query: 'turmeric' }, listings: [] }],
      choice: { sellerSlug: SEEDED_SELLER.slug, items: [{ sku: 'TUR-100', quantity: 2 }] },
      rationale: 'The buyer asked for turmeric.',
    };
    await db.update(purchases).set({ decisionRecord: decision }).where(eq(purchases.id, purchaseId));

    const { jws } = await issueReceipt(deps, purchaseId);

    const payload = await verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload);
    expect(payload.agent).toEqual({ decisionHash: hashOf(decision) });
  });

  it('makes no agent claim for a purchase with no decision record', async () => {
    const { deps, purchaseId } = await setUpCaptured();

    const { jws } = await issueReceipt(deps, purchaseId);

    expect(await verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload)).not.toHaveProperty('agent');
  });

  it('names the buyer as the approver of a purchase they approved', async () => {
    const { deps, purchaseId } = await setUpCaptured('ASK');

    const { jws } = await issueReceipt(deps, purchaseId);

    const payload = await verifyJws(jws, 'behest-receipt+jws', jwks, ReceiptPayload);
    expect(payload.decision).toMatchObject({ verdict: 'ASK', approver: 'human' });
  });

  it('returns the receipt already issued when called again, keeping one receipt', async () => {
    const { db, deps, purchaseId } = await setUpCaptured();

    const first = await issueReceipt(deps, purchaseId);
    const second = await issueReceipt(deps, purchaseId);

    expect(second).toEqual(first);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await eventsOf(db, purchaseId)).toEqual([{ kind: 'receipt', data: { receiptId: first.receiptId } }]);
  });

  it('keeps one receipt when two calls overlap, and both return it', async () => {
    const { db, deps, purchaseId } = await setUpCaptured();

    const [first, second] = await Promise.all([issueReceipt(deps, purchaseId), issueReceipt(deps, purchaseId)]);

    expect(second).toEqual(first);
    expect(await db.select({ id: receipts.id }).from(receipts)).toEqual([{ id: first.receiptId }]);
    expect(await eventsOf(db, purchaseId)).toHaveLength(1);
  });

  it('refuses a purchase whose payment has not been captured', async () => {
    const { db, deps, purchaseId } = await setUp('charging');

    await expect(issueReceipt(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} is charging`);

    expect(await db.select().from(receipts)).toEqual([]);
  });
});
