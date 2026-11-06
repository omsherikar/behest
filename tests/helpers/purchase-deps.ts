import { eq } from 'drizzle-orm';
import { purchases, wallets, type PurchaseStatus, type WalletStatus } from '@/lib/db/schema';
import { GATE_RULES } from '@/lib/gate/rules';
import type { PurchaseDeps, SellerPort } from '@/lib/purchases/deps';
import { generateSigningKey, loadSigningKey } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { verifyReceipt } from '@/lib/receipts/verify-receipt';
import { FakePaypal } from '@/tests/helpers/fake-paypal';
import { seedPurchase, seededCart } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// An allowed purchase ready to be charged, receipted and delivered, with everything the purchase
// orchestrator depends on: a database, a fake PayPal, a real signing key, a fake seller and a clock
// the test can move.

export const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
export const signer = createSigner(key);
export const jwks = await signer.jwks();

/** With milliseconds, so a receipt has to drop them from its whole-second `iat`. */
export const NOW = new Date('2026-11-06T12:00:00.750Z');
/** When PayPal captured a purchase seeded as already captured. */
export const CAPTURED_AT = new Date('2026-11-06T11:59:58.125Z');

/** The gate's outcomes for the seeded purchase: every rule passed. */
export const PASSED = GATE_RULES.map((rule) => ({ rule, result: 'pass' as const, detail: `${rule} passed` }));

type Order = Parameters<SellerPort['acceptAgentOrder']>[0];

/**
 * A seller that checks each receipt as an outside seller would, with nothing but Behest's public
 * keys, and accepts each receipt id once. A test can make it refuse every order, fail to answer, or
 * accept an order and lose its answer, and can run something while the seller is deciding.
 */
export class FakeSeller implements SellerPort {
  readonly orders: Order[] = [];
  mode: 'verify' | 'reject' | 'unreachable' | 'lose_answer' = 'verify';
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
    if (this.mode === 'lose_answer') throw new TypeError('fetch failed');
    return { status: 'accepted' };
  }
}

/**
 * A database with one allowed purchase in `status` whose every gate rule passed, its buyer's
 * wallet (linked unless told otherwise, or none), a fake PayPal, a fake seller and a clock the
 * test can move.
 */
export async function setUp(status: PurchaseStatus = 'proposed', { wallet = 'linked' }: { wallet?: WalletStatus | null } = {}) {
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
export async function setUpCaptured(verdict: 'ALLOW' | 'ASK' = 'ALLOW') {
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
