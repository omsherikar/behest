import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { purchases, receipts, wallets, type PurchaseStatus, type WalletStatus } from '@/lib/db/schema';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { GATE_RULES } from '@/lib/gate/rules';
import type { PurchaseDeps, SellerPort } from '@/lib/purchases/deps';
import { issueReceipt } from '@/lib/purchases/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey } from '@/lib/receipts/keys';
import { createSigner, verifyJws } from '@/lib/receipts/sign';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { eventsOf, SEEDED_SELLER, seedPurchase, seededCart } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const jwks = await signer.jwks();

/** With milliseconds, so a receipt has to drop them from its whole-second `iat`. */
const NOW = new Date('2026-11-06T12:00:00.750Z');
/** When PayPal captured a purchase seeded as already captured. */
const CAPTURED_AT = new Date('2026-11-06T11:59:58.125Z');
/** What the seeded mandate row stores. */
const MANDATE_JWS = 'mandate.jws.value';
const SEEDED_HASH = 'a'.repeat(64);

/** The gate's outcomes for the seeded purchase: every rule passed. */
const PASSED = GATE_RULES.map((rule) => ({ rule, result: 'pass' as const, detail: `${rule} passed` }));

type Order = Parameters<SellerPort['acceptAgentOrder']>[0];

/**
 * A seller that checks each receipt as an outside seller would, with nothing but Behest's public
 * keys, and accepts each receipt id once. A test can make it refuse every order, or fail to answer.
 */
class FakeSeller implements SellerPort {
  readonly orders: Order[] = [];
  mode: 'verify' | 'reject' | 'unreachable' = 'verify';
  private readonly accepted = new Set<string>();

  constructor(private readonly now: () => Date) {}

  async acceptAgentOrder(order: Order): Promise<{ status: 'accepted' | 'rejected'; reason?: string }> {
    this.orders.push(order);
    if (this.mode === 'unreachable') throw new TypeError('fetch failed');
    if (this.mode === 'reject') return { status: 'rejected', reason: 'out_of_stock' };
    const result = await verifyReceipt({
      jws: order.receiptJws,
      cart: order.cart,
      sellerSlug: order.sellerSlug,
      jwks,
      now: this.now(),
      seen: async (receiptId) => this.accepted.has(receiptId),
    });
    if (!result.ok) return { status: 'rejected', reason: result.reason };
    this.accepted.add(result.payload.id);
    return { status: 'accepted' };
  }
}

/**
 * A database with one allowed purchase in `status` whose every gate rule passed, its buyer's
 * wallet (linked unless told otherwise, or none), a fake PayPal, a fake seller and a clock the
 * test can move.
 */
async function setUp(status: PurchaseStatus = 'proposed', { wallet = 'linked' }: { wallet?: WalletStatus | null } = {}) {
  const db = await createTestDb();
  const paypal = new FakePaypal();
  const seeded = await seedPurchase(db, status);
  await db.update(purchases).set({ gateOutcomes: PASSED }).where(eq(purchases.id, seeded.purchaseId));
  if (wallet) {
    await db.insert(wallets).values({
      buyerId: seeded.buyerId,
      status: wallet,
      paypalCustomerId: 'CUSTOMER-1',
      paymentTokenId: 'TOKEN-1',
      linkedAt: NOW,
    });
  }
  const clock = { now: NOW };
  const now = () => clock.now;
  const seller = new FakeSeller(now);
  const deps: PurchaseDeps = {
    db,
    paypal,
    signer,
    intent: async () => {
      throw new Error('charging never runs the intent check');
    },
    sellers: seller,
    appUrl: 'https://behest.example.com',
    now,
  };
  return { ...seeded, db, paypal, seller, clock, deps };
}

/** A purchase PayPal has captured: the fake PayPal holds the capture, and the row its ids. */
async function setUpCaptured(verdict: 'ALLOW' | 'ASK' = 'ALLOW') {
  const s = await setUp('captured');
  const { orderId, captureId } = await s.paypal.chargeSavedWallet({
    paymentTokenId: 'TOKEN-1',
    amountCents: seededCart.totalCents,
    description: 'Seeded capture',
    invoiceId: s.purchaseId,
    requestId: `${s.purchaseId}:charge`,
  });
  await s.db
    .update(purchases)
    .set({
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: CAPTURED_AT,
      finalVerdict: verdict,
      approver: verdict === 'ALLOW' ? 'policy' : 'human',
    })
    .where(eq(purchases.id, s.purchaseId));
  return { ...s, orderId, captureId };
}

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
