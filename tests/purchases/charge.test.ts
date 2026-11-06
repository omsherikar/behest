import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { jobs, payouts, purchases, receipts, refunds, wallets, type PurchaseStatus, type WalletStatus } from '@/lib/db/schema';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { GATE_RULES } from '@/lib/gate/rules';
import { deliverToSeller } from '@/lib/purchases/deliver';
import type { PurchaseDeps, SellerPort } from '@/lib/purchases/deps';
import { issueReceipt } from '@/lib/purchases/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey } from '@/lib/receipts/keys';
import { createSigner, verifyJws } from '@/lib/receipts/sign';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { eventsOf, SEEDED_SELLER, seedPurchase, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
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
 * keys, and accepts each receipt id once. A test can make it refuse every order, or fail to answer,
 * and can run something while the seller is deciding.
 */
class FakeSeller implements SellerPort {
  readonly orders: Order[] = [];
  mode: 'verify' | 'reject' | 'unreachable' = 'verify';
  whileDeciding: () => Promise<void> = async () => {};
  private readonly accepted = new Set<string>();

  constructor(private readonly now: () => Date) {}

  async acceptAgentOrder(order: Order): Promise<{ status: 'accepted' | 'rejected'; reason?: string }> {
    this.orders.push(order);
    await this.whileDeciding();
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

/** A captured purchase with its receipt issued, ready to hand to the seller. */
async function setUpReceipted() {
  const s = await setUpCaptured();
  const receipt = await issueReceipt(s.deps, s.purchaseId);
  return { ...s, ...receipt };
}

/** The purchase's events after its receipt, the point delivery starts from. */
async function eventsAfterReceipt(db: PurchaseDeps['db'], purchaseId: string) {
  const events = await eventsOf(db, purchaseId);
  return events.slice(events.findIndex((e) => e.kind === 'receipt') + 1);
}

describe('deliverToSeller', () => {
  it('hands the seller the cart and receipt, and pays the seller once it accepts', async () => {
    const { db, deps, paypal, seller, purchaseId, receiptId, jws } = await setUpReceipted();

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toEqual([{ sellerSlug: SEEDED_SELLER.slug, cart: seededCart, receiptJws: jws }]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(paypal.payouts).toEqual([expect.objectContaining({ senderBatchId: `${purchaseId}:payout`, amountCents: seededCart.totalCents })]);
    // payoutSeller queues the poll of its payout; delivery queues nothing of its own.
    expect(await db.select({ kind: jobs.kind }).from(jobs)).toEqual([{ kind: 'payout_poll' }]);
    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_accepted', data: { receiptId } },
      { kind: 'status', data: { from: 'captured', to: 'accepted' } },
    ]);
  });

  it('refunds the captured amount, once, when the seller rejects the order', async () => {
    const { db, deps, paypal, seller, purchaseId, captureId } = await setUpReceipted();
    seller.mode = 'reject';

    await deliverToSeller(deps, purchaseId);

    const note = `The seller did not accept Behest order ${purchaseId}.`;
    expect(paypal.callsTo('refundCapture')).toEqual([
      [{ captureId, amountCents: seededCart.totalCents, note, requestId: `${purchaseId}:refund` }],
    ]);
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await db.select().from(refunds)).toEqual([
      expect.objectContaining({
        purchaseId,
        amountCents: seededCart.totalCents,
        currency: 'USD',
        paypalRefundId: paypal.refunds[0].refundId,
        status: 'COMPLETED',
        reason: note,
      }),
    ]);
    expect(paypal.payouts).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund', data: { refundId: paypal.refunds[0].refundId, status: 'COMPLETED', amountCents: seededCart.totalCents } },
      { kind: 'status', data: { from: 'captured', to: 'refunded' } },
    ]);
  });

  it('asks again with the same request id when a refund answer is lost, refunding once', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    paypal.failNext('refundCapture', 'lost_response');

    await deliverToSeller(deps, purchaseId);

    const requestIds = paypal.callsTo('refundCapture').map(([call]) => call.requestId);
    expect(requestIds).toEqual([`${purchaseId}:refund`, `${purchaseId}:refund`]);
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('refunded');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId }).from(refunds)).toEqual([
      { paypalRefundId: paypal.refunds[0].refundId },
    ]);
  });

  it('keeps a refund whose answer is lost twice on record, and the purchase captured', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    paypal.failNext('refundCapture', 'lost_response');
    paypal.failNext('refundCapture', 'lost_response');

    await deliverToSeller(deps, purchaseId);

    // PayPal did refund, so the purchase must not look as if its money is settled either way.
    expect(paypal.refunds).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId, status: refunds.status }).from(refunds)).toEqual([
      { paypalRefundId: null, status: 'PENDING' },
    ]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_unknown', data: { requestId: `${purchaseId}:refund`, error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('keeps the purchase captured when PayPal answers the refund in a status that returns nothing', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    vi.spyOn(paypal, 'refundCapture').mockResolvedValue({ refundId: 'REFUND-9', status: 'FAILED' });

    await deliverToSeller(deps, purchaseId);

    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await db.select({ paypalRefundId: refunds.paypalRefundId, status: refunds.status }).from(refunds)).toEqual([
      { paypalRefundId: 'REFUND-9', status: 'FAILED' },
    ]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_failed', data: { refundId: 'REFUND-9', status: 'FAILED', amountCents: seededCart.totalCents } },
    ]);
  });

  it('leaves the purchase captured, refunding and paying nothing, when the seller cannot be reached', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'unreachable';

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(paypal.payouts).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_unknown', data: { error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('does not refund a rejected order whose seller has a payout on record', async () => {
    const { db, deps, paypal, seller, purchaseId, sellerId } = await setUpReceipted();
    seller.mode = 'reject';
    await db.insert(payouts).values({ purchaseId, sellerId, amountCents: seededCart.totalCents, senderBatchId: `${purchaseId}:payout` });

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('captured');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_skipped', data: { reason: 'the seller has a payout on record' } },
    ]);
  });

  it('refunds nothing when the purchase has moved on by the time the seller rejects it', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    seller.mode = 'reject';
    seller.whileDeciding = async () => {
      await db.update(purchases).set({ status: 'accepted' }).where(eq(purchases.id, purchaseId));
    };

    await deliverToSeller(deps, purchaseId);

    expect(paypal.callsTo('refundCapture')).toEqual([]);
    expect(await db.select().from(refunds)).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([
      { kind: 'seller_rejected', data: { reason: 'out_of_stock' } },
      { kind: 'refund_skipped', data: { reason: 'the purchase is accepted' } },
    ]);
  });

  it('does not hand over a purchase that is no longer captured', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUpReceipted();
    await db.update(purchases).set({ status: 'accepted' }).where(eq(purchases.id, purchaseId));

    await deliverToSeller(deps, purchaseId);

    expect(seller.orders).toEqual([]);
    expect(paypal.payouts).toEqual([]);
    expect(await eventsAfterReceipt(db, purchaseId)).toEqual([]);
  });
});
