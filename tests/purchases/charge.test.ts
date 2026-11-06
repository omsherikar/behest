import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { jobs, payouts, purchases, receipts, refunds, wallets, type PurchaseStatus, type WalletStatus } from '@/lib/db/schema';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { GATE_RULES } from '@/lib/gate/rules';
import { runDueJobs } from '@/lib/jobs/queue';
import { chargeAllowed, completeCapture, retryCharge } from '@/lib/purchases/charge';
import { deliverToSeller } from '@/lib/purchases/deliver';
import type { PurchaseDeps, SellerPort } from '@/lib/purchases/deps';
import { issueReceipt } from '@/lib/purchases/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey } from '@/lib/receipts/keys';
import { createSigner, verifyJws } from '@/lib/receipts/sign';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { eventsOf, purchaseRow, SEEDED_SELLER, seedPurchase, seededCart, statusOf } from '@/tests/helpers/seed-purchase';
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

const HOUR_MS = 60 * 60 * 1000;

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

const chargeRequestId = (purchaseId: string) => `${purchaseId}:charge`;

/** The request id of every charge PayPal was asked for, in order. */
function chargeRequestIds(paypal: FakePaypal): string[] {
  return paypal.callsTo('chargeSavedWallet').map(([request]) => request.requestId);
}

/** The kinds of the purchase's events other than status changes, in order. */
async function stepsOf(db: PurchaseDeps['db'], purchaseId: string): Promise<string[]> {
  return (await eventsOf(db, purchaseId)).filter((e) => e.kind !== 'status').map((e) => e.kind);
}

/** A purchase left charging by two thrown charge attempts, with PayPal having captured the first when `lost` says so. */
async function setUpUnknownCharge({ lost }: { lost: boolean }) {
  const s = await setUp();
  const failure = lost ? 'lost_response' : 'network';
  s.paypal.failNext('chargeSavedWallet', failure);
  s.paypal.failNext('chargeSavedWallet', failure);
  await chargeAllowed(s.deps, s.purchaseId);
  return s;
}

describe('chargeAllowed', () => {
  it('charges the saved wallet, signs a receipt and ends accepted with the seller paid', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();

    const outcome = await chargeAllowed(deps, purchaseId);

    const [receipt] = await db.select().from(receipts);
    expect(outcome).toEqual({ purchaseId, verdict: 'ALLOW', status: 'accepted', reasons: [], approveUrl: null, receiptId: receipt.id });
    expect(paypal.callsTo('chargeSavedWallet')).toEqual([
      [
        {
          paymentTokenId: 'TOKEN-1',
          amountCents: seededCart.totalCents,
          description: `Behest order ${purchaseId}`,
          invoiceId: purchaseId,
          requestId: chargeRequestId(purchaseId),
        },
      ],
    ]);
    expect(paypal.captures).toHaveLength(1);
    const [{ orderId, captureId }] = paypal.captures;
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'accepted',
      approver: 'policy',
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: NOW,
    });

    // The receipt passes every check an outside seller runs, against the cart the seller received.
    const verified = await verifyReceipt({
      jws: receipt.jws,
      cart: seededCart,
      sellerSlug: SEEDED_SELLER.slug,
      jwks,
      now: NOW,
      seen: async () => false,
    });
    expect(verified).toMatchObject({
      ok: true,
      payload: {
        id: receipt.id,
        cart: { hash: hashOf(seededCart) },
        payment: { orderId, captureId, amountCents: seededCart.totalCents, capturedAt: NOW.toISOString() },
      },
    });
    expect(seller.orders).toEqual([{ sellerSlug: SEEDED_SELLER.slug, cart: seededCart, receiptJws: receipt.jws }]);
    expect(paypal.payouts).toHaveLength(1);
    expect(await db.select({ kind: jobs.kind }).from(jobs)).toEqual([{ kind: 'payout_poll' }]);
  });

  it('logs the charge, capture, receipt and seller acceptance in order, each before the status it causes', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();

    const { receiptId } = await chargeAllowed(deps, purchaseId);

    const [{ orderId, captureId }] = paypal.captures;
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      {
        kind: 'charge',
        data: { requestId: chargeRequestId(purchaseId), amountCents: seededCart.totalCents, startedAt: NOW.toISOString() },
      },
      { kind: 'capture', data: { orderId, captureId } },
      { kind: 'status', data: { from: 'charging', to: 'captured' } },
      { kind: 'receipt', data: { receiptId } },
      { kind: 'seller_accepted', data: { receiptId } },
      { kind: 'status', data: { from: 'captured', to: 'accepted' } },
    ]);
  });

  it('asks again with the same request id when the answer is lost after PayPal captured, capturing once', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', 'lost_response');

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(chargeRequestIds(paypal)).toEqual([chargeRequestId(purchaseId), chargeRequestId(purchaseId)]);
    expect(paypal.captures).toHaveLength(1);
    expect(outcome.status).toBe('accepted');
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
  });

  it('ends failed with no receipt when PayPal declines the charge', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', receiptId: null });
    expect(await statusOf(db, purchaseId)).toBe('failed');
    expect(paypal.captures).toEqual([]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(1)).toEqual([
      expect.objectContaining({ kind: 'charge' }),
      { kind: 'charge_declined', data: { requestId: chargeRequestId(purchaseId) } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('leaves the purchase charging, its budget reserved, with a charge_retry job queued when PayPal fails twice', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', 'network');
    paypal.failNext('chargeSavedWallet', 'network');

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(chargeRequestIds(paypal)).toEqual([chargeRequestId(purchaseId), chargeRequestId(purchaseId)]);
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await statusOf(db, purchaseId)).toBe('charging');
    expect(await db.select({ kind: jobs.kind, payload: jobs.payload, runAt: jobs.runAt }).from(jobs)).toEqual([
      { kind: 'charge_retry', payload: { purchaseId }, runAt: new Date(NOW.getTime() + 30_000) },
    ]);
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([
      { kind: 'charge_unknown', data: { requestId: chargeRequestId(purchaseId), error: 'fetch failed', errorClass: 'TypeError' } },
    ]);
  });

  it('keeps a pending capture charging with its PayPal ids, issuing no receipt and calling no seller', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });

    const outcome = await chargeAllowed(deps, purchaseId);

    const [{ orderId, captureId }] = paypal.captures;
    expect(outcome).toMatchObject({ status: 'charging', receiptId: null });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({
      status: 'charging',
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: null,
    });
    expect(await db.select().from(receipts)).toEqual([]);
    expect(seller.orders).toEqual([]);
    // Only PayPal's webhook can say when the capture completes, so nothing is queued to ask again.
    expect(await db.select().from(jobs)).toEqual([]);
    expect((await eventsOf(db, purchaseId)).slice(2)).toEqual([{ kind: 'capture_pending', data: { orderId, captureId } }]);
  });

  it.each([
    ['no wallet', null],
    ['a wallet still being linked', 'pending'],
    ['a revoked wallet', 'revoked'],
  ] as const)('fails without asking PayPal when the buyer has %s', async (_, wallet) => {
    const { db, deps, paypal, purchaseId } = await setUp('proposed', { wallet });

    const outcome = await chargeAllowed(deps, purchaseId);

    expect(outcome).toMatchObject({ status: 'failed', receiptId: null });
    expect(paypal.calls).toEqual([]);
    expect(await eventsOf(db, purchaseId)).toEqual([
      { kind: 'status', data: { from: 'proposed', to: 'charging' } },
      { kind: 'charge_failed', data: { reason: 'The buyer has no linked PayPal wallet.' } },
      { kind: 'status', data: { from: 'charging', to: 'failed' } },
    ]);
  });

  it('refuses a purchase that was not allowed, changing nothing', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    await db.update(purchases).set({ finalVerdict: 'ASK' }).where(eq(purchases.id, purchaseId));

    await expect(chargeAllowed(deps, purchaseId)).rejects.toThrow(`purchase ${purchaseId} has the final verdict ASK`);

    expect(paypal.calls).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('proposed');
    expect(await eventsOf(db, purchaseId)).toEqual([]);
  });

  it('returns where the purchase stands, charging nothing more, when called again', async () => {
    const { deps, paypal, seller, purchaseId } = await setUp();
    const first = await chargeAllowed(deps, purchaseId);

    const second = await chargeAllowed(deps, purchaseId);

    expect(second).toEqual(first);
    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
  });
});

describe('retryCharge', () => {
  it('runs from its job, replays the same request id and ends accepted with exactly one capture', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCharge({ lost: true });
    clock.now = new Date(NOW.getTime() + 30_000);

    const processed = await runDueJobs(
      db,
      { charge_retry: (payload, d) => retryCharge(d, String(payload.purchaseId)) },
      deps,
      () => clock.now,
    );

    expect(processed).toBe(1);
    expect(await db.select({ kind: jobs.kind, status: jobs.status }).from(jobs).where(eq(jobs.kind, 'charge_retry'))).toEqual([
      { kind: 'charge_retry', status: 'done' },
    ]);
    expect(chargeRequestIds(paypal)).toEqual(Array(3).fill(chargeRequestId(purchaseId)));
    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'charge_unknown', 'capture', 'receipt', 'seller_accepted']);
  });

  it('charges once when PayPal never received the first two attempts', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.captures).toHaveLength(1);
    expect(await statusOf(db, purchaseId)).toBe('accepted');
  });

  it('ends failed when the replay is declined', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });
    paypal.failNext('chargeSavedWallet', { status: 'DECLINED' });

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(await statusOf(db, purchaseId)).toBe('failed');
    expect(await db.select().from(receipts)).toEqual([]);
  });

  it('throws, leaving the purchase charging and its log as it was, while PayPal still cannot answer', async () => {
    const { db, deps, paypal, purchaseId } = await setUpUnknownCharge({ lost: false });
    const before = await eventsOf(db, purchaseId);
    paypal.failNext('chargeSavedWallet', 'network');
    paypal.failNext('chargeSavedWallet', 'network');

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('fetch failed');

    expect(chargeRequestIds(paypal)).toEqual(Array(4).fill(chargeRequestId(purchaseId)));
    expect(await statusOf(db, purchaseId)).toBe('charging');
    expect(await eventsOf(db, purchaseId)).toEqual(before);
  });

  it('does nothing for a purchase that is no longer charging', async () => {
    const { deps, paypal, purchaseId } = await setUp('accepted');

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.calls).toEqual([]);
  });

  it('leaves a pending capture to the webhook that reports it', async () => {
    const { db, deps, paypal, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
    await chargeAllowed(deps, purchaseId);

    expect(await retryCharge(deps, purchaseId)).toBe('done');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture_pending']);
  });

  it('refuses to replay a charge older than PayPal keeps its request id', async () => {
    const { db, deps, paypal, clock, purchaseId } = await setUpUnknownCharge({ lost: false });
    clock.now = new Date(NOW.getTime() + 5 * HOUR_MS + 1);

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('too old to replay');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('refuses to replay a charge once the buyer has unlinked the wallet', async () => {
    const { db, deps, paypal, buyerId, purchaseId } = await setUpUnknownCharge({ lost: false });
    await db.update(wallets).set({ status: 'revoked' }).where(eq(wallets.buyerId, buyerId));

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('no linked wallet');

    expect(paypal.callsTo('chargeSavedWallet')).toHaveLength(2);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });

  it('refuses a charging purchase that has no saved-wallet charge to replay', async () => {
    const { db, deps, paypal, purchaseId } = await setUp('charging');

    await expect(retryCharge(deps, purchaseId)).rejects.toThrow('no saved-wallet charge to replay');

    expect(paypal.calls).toEqual([]);
    expect(await statusOf(db, purchaseId)).toBe('charging');
  });
});

describe('completeCapture', () => {
  it('takes a pending capture on to its receipt and delivery once PayPal completes it', async () => {
    const { db, deps, paypal, seller, clock, purchaseId } = await setUp();
    paypal.failNext('chargeSavedWallet', { status: 'PENDING' });
    await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;
    clock.now = new Date(NOW.getTime() + 60_000);

    const outcome = await completeCapture(deps, purchaseId, { orderId, captureId });

    const [receipt] = await db.select().from(receipts);
    expect(outcome).toMatchObject({ status: 'accepted', receiptId: receipt.id });
    expect(await purchaseRow(db, purchaseId)).toMatchObject({ paypalOrderId: orderId, paypalCaptureId: captureId, capturedAt: clock.now });
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture_pending', 'capture', 'receipt', 'seller_accepted']);
  });

  it('does nothing more for a capture already recorded', async () => {
    const { db, deps, paypal, seller, purchaseId } = await setUp();
    const charged = await chargeAllowed(deps, purchaseId);
    const [{ orderId, captureId }] = paypal.captures;

    const outcome = await completeCapture(deps, purchaseId, { orderId, captureId });

    expect(outcome).toEqual(charged);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(seller.orders).toHaveLength(1);
    expect(paypal.payouts).toHaveLength(1);
    expect(await stepsOf(db, purchaseId)).toEqual(['charge', 'capture', 'receipt', 'seller_accepted']);
  });
});
