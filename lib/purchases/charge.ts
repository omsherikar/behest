import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { purchaseEvents, purchases, receipts, wallets, type PurchaseStatus } from '@/lib/db/schema';
import { enqueue, type JobOutcome } from '@/lib/jobs/queue';
import { isOrderNotApproved } from '@/lib/paypal/orders';
import type { PaypalPort } from '@/lib/paypal/port';
import { deliverToSeller } from './deliver';
import type { ProposalOutcome, PurchaseDeps } from './deps';
import { appendEvent, StaleTransition, transition } from './events';
import { MANDATE_NOT_ACTIVE, purchaseMandateActive } from './mandate-check';
import { issueReceipt, receiptBlocker } from './receipt';
import { describeFailure } from './settle';

// Taking a purchase's payment (architecture sections 6.2 and 6.3). The gate allowed it, so Behest
// charges the buyer's saved PayPal wallet with no buyer present, or the buyer approved its order at
// PayPal, so Behest captures that order (see approval.ts). Either way Behest then signs a receipt
// for the captured payment and hands the order to the seller.
//
// Every payment of a purchase carries one request id, `${purchaseId}:charge` for a charge and
// `${purchaseId}:capture` for a capture, so PayPal answers a repeat with the first result and never
// takes the money twice. Only a DECLINED answer, or PayPal refusing to capture an order the buyer
// has not approved, means no money moved. Any error may follow a payment PayPal carried out, so the
// purchase then stays `charging`, still counted against the budget, until a replay under the same
// request id finds out. That replay is queued as a `charge_retry` job before PayPal is first asked,
// so a payment whose answer is never recorded, because the process stopped or the database failed,
// is still followed up. No database lock is held while PayPal is asked.

type ChargeDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'signer' | 'sellers' | 'now'>;
type ChargeRequest = Parameters<PaypalPort['chargeSavedWallet']>[0];
/** The capture of an order its buyer approved at PayPal. */
type CaptureRequest = { orderId: string; requestId: string };
/** What Behest asks PayPal for to take a purchase's payment. */
export type PaymentRequest = ChargeRequest | CaptureRequest;
type ChargeAnswer = Awaited<ReturnType<PaypalPort['chargeSavedWallet']>>;
/** PayPal's answer to a payment request. NOT_APPROVED: the buyer has not approved the order to capture, so nothing moved. */
type PaymentAnswer = ChargeAnswer | { orderId: string; status: 'NOT_APPROVED' };
type Capture = { orderId: string; captureId: string };

const NO_WALLET = 'The buyer has no linked PayPal wallet.';

/**
 * A `charge` event's data: the request exactly as sent to PayPal, so a replay can send the same
 * bytes, and when it was first sent, on the app's clock, the one the replay window is measured on.
 * The request is a saved-wallet charge or the capture of an approved order.
 */
const SentPayment = z.union([
  z.object({
    paymentTokenId: z.string().min(1),
    amountCents: z.number().int().positive(),
    description: z.string().min(1),
    invoiceId: z.string().min(1),
    requestId: z.string().min(1),
    startedAt: z.iso.datetime(),
  }),
  z.object({ orderId: z.string().min(1), requestId: z.string().min(1), startedAt: z.iso.datetime() }),
]);
type SentPayment = z.infer<typeof SentPayment>;

/**
 * How long after a charge starts its `charge_retry` job first runs. By then a charge that went
 * normally has long been recorded, and the job finds nothing to do.
 */
const CHARGE_RETRY_DELAY_MS = 2 * 60 * 1000;

/**
 * The longest after its first attempt that a payment is replayed. PayPal keeps the request id of an
 * order created with a saved wallet for 6 hours; after that the same id would create a new order
 * and charge the buyer again. The replay stops an hour short of that, for captures too.
 */
const REPLAY_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * Charges an allowed purchase's buyer from their saved wallet and carries it as far as it can go.
 * Moves the purchase from `proposed` to `charging`, logs a `charge` event and queues a
 * `charge_retry` job for retryCharge, all in one transaction, then asks PayPal, asking once more
 * with the same request id if that throws. Then:
 * - COMPLETED: completeCapture records the capture, issues the receipt and delivers the order;
 * - PENDING: the order and capture ids are stored and a `capture_pending` event logged; the purchase
 *   stays `charging` with no receipt until PayPal's webhook reports the capture completed;
 * - DECLINED: a `charge_declined` event, and the purchase ends `failed`;
 * - a second thrown error: a `charge_unknown` event, with the purchase left `charging` for the
 *   queued job to replay.
 * A purchase whose mandate has been revoked or has expired since the gate decided, or that could
 * not be given its receipt once captured, fails with a `charge_refused` event, and one whose buyer
 * has no linked wallet with a `charge_failed` event, each saying why; PayPal is never asked. A purchase another call has already moved on from `proposed` is returned
 * as it stands. Throws, changing nothing, for a purchase whose final verdict is not ALLOW.
 */
export async function chargeAllowed(deps: ChargeDeps, purchaseId: string): Promise<ProposalOutcome> {
  const { db } = deps;
  const [purchase] = await db
    .select({ buyerId: purchases.buyerId, finalVerdict: purchases.finalVerdict, totalCents: purchases.totalCents })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
  if (purchase.finalVerdict !== 'ALLOW') {
    throw new Error(
      `purchase ${purchaseId} has the final verdict ${purchase.finalVerdict}, and only an allowed purchase is charged without its buyer`,
    );
  }
  if (purchase.totalCents === null) throw new Error(`allowed purchase ${purchaseId} has no total`);

  const request = await startCharge(deps, purchaseId, purchase.buyerId, purchase.totalCents);
  if (!request) return purchaseOutcome(db, purchaseId);
  return takePayment(deps, purchaseId, request);
}

/**
 * Replays the payment of a purchase whose payment was never recorded: the handler of the
 * `charge_retry` job queued with every charge and every capture of an approved order. It sends
 * exactly the request its `charge` event recorded, payment token or order id and request id
 * included, so PayPal either reports the payment it already took or takes it now, and goes on as
 * takePayment does with the answer; that is safe even while another call acts on the same answer.
 * `done` once PayPal has answered, and also, without asking PayPal, for a purchase no longer
 * `charging`, such as one sent back for its buyer's approval, or one whose capture is pending, which
 * only PayPal's webhook can move on. Throws, so the job is retried with backoff, while PayPal still
 * cannot answer. Also throws, without asking PayPal, for a purchase with no charge or capture to
 * replay, one paid for too long ago to replay safely, or a saved-wallet charge whose buyer has no
 * linked wallet any more: money may have moved, so an operator checks PayPal.
 */
export async function retryCharge(deps: ChargeDeps, purchaseId: string): Promise<JobOutcome> {
  const { db } = deps;
  const [purchase] = await db
    .select({
      status: purchases.status,
      buyerId: purchases.buyerId,
      captureId: purchases.paypalCaptureId,
    })
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
  if (purchase.status !== 'charging' || purchase.captureId !== null) return 'done';

  const sent = await sentPayment(db, purchaseId);
  if (!sent) throw new Error(`purchase ${purchaseId} has no recorded charge or capture to replay`);
  const { startedAt, ...request } = sent;
  if (deps.now().getTime() - Date.parse(startedAt) > REPLAY_WINDOW_MS) {
    throw new Error(`the charge of purchase ${purchaseId} is too old to replay safely; check PayPal before charging again`);
  }
  // A charge replay sends the token the charge was sent with, but only while the buyer still has a
  // linked wallet: one who has unlinked it since must not be charged by a request PayPal never got.
  if ('paymentTokenId' in request && !(await linkedPaymentToken(db, purchase.buyerId))) {
    throw new Error(
      `the buyer of purchase ${purchaseId} has no linked wallet any more, so its charge is not replayed; check PayPal`,
    );
  }

  await applyAnswer(deps, purchaseId, request.requestId, await sendPayment(deps.paypal, request));
  return 'done';
}

/**
 * Logs a payment request as the purchase's `charge` event, with when it is first sent, and queues
 * the `charge_retry` job that replays it. Called in the transaction that moves the purchase to
 * `charging`, before PayPal is asked, so a payment whose answer is never recorded is followed up.
 */
export async function recordCharge(db: Db, purchaseId: string, request: PaymentRequest, now: Date): Promise<void> {
  await appendEvent(db, purchaseId, 'charge', { ...request, startedAt: now.toISOString() } satisfies SentPayment);
  await enqueue(db, 'charge_retry', { purchaseId }, new Date(now.getTime() + CHARGE_RETRY_DELAY_MS));
}

/**
 * Sends the payment request recordCharge logged for a `charging` purchase, asking once more with the
 * same request id if that throws, and carries the purchase as far as PayPal's answer allows:
 * - COMPLETED: completeCapture records the capture, issues the receipt and delivers the order;
 * - PENDING: the order and capture ids are stored and a `capture_pending` event logged; the purchase
 *   stays `charging` with no receipt until PayPal's webhook reports the capture completed;
 * - DECLINED: a `charge_declined` event, and the purchase ends `failed`;
 * - the order to capture is not approved: an `approval_pending` event, and the purchase goes back
 *   to `awaiting_approval`, its approval link kept, for the buyer to approve;
 * - a second thrown error: a `charge_unknown` event, with the purchase left `charging` for the
 *   queued job to replay.
 * Returns where the purchase then stands.
 */
export async function takePayment(deps: ChargeDeps, purchaseId: string, request: PaymentRequest): Promise<ProposalOutcome> {
  const { db } = deps;
  let answer: PaymentAnswer;
  try {
    answer = await sendPayment(deps.paypal, request);
  } catch (error) {
    // The job queued with the payment replays it; one job per payment is enough.
    await appendEvent(db, purchaseId, 'charge_unknown', { requestId: request.requestId, ...describeFailure(error) });
    return purchaseOutcome(db, purchaseId);
  }
  return applyAnswer(deps, purchaseId, request.requestId, answer);
}

/**
 * Takes a `charging` purchase whose PayPal capture has COMPLETED to its receipt and delivery:
 * records the capture's ids and time with a `capture` event and moves the purchase to `captured`,
 * then issues the receipt and hands the order to the seller. Used by the charge, its retry, and
 * PayPal's webhook for a capture that was pending. The purchase row is locked while the capture is
 * checked and recorded, so only one call records it and goes on; a capture reported again is a
 * quiet no-op. A capture of the purchase's own approval order is recorded the same way while the
 * purchase is `awaiting_approval` (see approvedSinceReopen), first moving it back to `charging`
 * with the buyer as its approver. Any other capture that does not fit the purchase, because the
 * purchase is not `charging` or already holds other PayPal ids, is never recorded over them: it is
 * logged as `capture_unmatched` for an operator, since PayPal holds money the purchase does not
 * account for. Either way the purchase is returned as it stands.
 */
export async function completeCapture(deps: ChargeDeps, purchaseId: string, capture: Capture): Promise<ProposalOutcome> {
  const { db } = deps;
  const { orderId, captureId } = capture;
  const recorded = await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status, orderId: purchases.paypalOrderId, captureId: purchases.paypalCaptureId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
    if (purchase.status !== 'charging' && purchase.captureId === captureId) return false;
    const approvedSince = approvedSinceReopen(purchase, orderId);
    const fits =
      approvedSince ||
      (purchase.status === 'charging' &&
        (purchase.captureId ?? captureId) === captureId &&
        (purchase.orderId ?? orderId) === orderId);
    if (!fits) {
      await appendEvent(tx, purchaseId, 'capture_unmatched', { captureId });
      return false;
    }
    if (approvedSince) await transition(tx, purchaseId, 'awaiting_approval', 'charging', { approver: 'human' });
    await appendEvent(tx, purchaseId, 'capture', { orderId, captureId });
    await transition(tx, purchaseId, 'charging', 'captured', {
      paypalOrderId: orderId,
      paypalCaptureId: captureId,
      capturedAt: deps.now(),
    });
    return true;
  });
  if (!recorded) return purchaseOutcome(db, purchaseId);
  await issueReceipt(deps, purchaseId);
  await deliverToSeller(deps, purchaseId);
  return purchaseOutcome(db, purchaseId);
}

/**
 * Where a purchase stands, as the orchestrator reports it: the final verdict (the gate's until the
 * intent check has run), the details of every gate rule that did not pass followed by the intent
 * check's reasons, the approval link and the receipt id, if any.
 */
export async function purchaseOutcome(db: Db, purchaseId: string): Promise<ProposalOutcome> {
  const [row] = await db
    .select({ purchase: purchases, receiptId: receipts.id })
    .from(purchases)
    .leftJoin(receipts, eq(receipts.purchaseId, purchases.id))
    .where(eq(purchases.id, purchaseId));
  if (!row) throw new Error(`there is no purchase ${purchaseId}`);
  const { purchase, receiptId } = row;
  const failedRules = purchase.gateOutcomes.filter((o) => o.result !== 'pass' && o.result !== 'skip').map((o) => o.detail);
  return {
    purchaseId,
    verdict: purchase.finalVerdict ?? purchase.gateVerdict,
    status: purchase.status,
    reasons: [...failedRules, ...(purchase.intent?.reasons ?? [])],
    approveUrl: purchase.approveUrl,
    receiptId,
  };
}

/**
 * Why a purchase about to be charged, or sent to its buyer to approve, must not be, or null when it
 * may: its mandate is no longer active and unexpired, read again with its row held FOR SHARE until
 * the caller's transaction ends, so no confirmation can revoke it before the payment is recorded; or
 * it could not be given its receipt once captured.
 */
export async function chargeRefusal(db: Db, purchaseId: string, now: Date): Promise<string | null> {
  if (!(await purchaseMandateActive(db, purchaseId, now))) return MANDATE_NOT_ACTIVE;
  return receiptBlocker(db, purchaseId, now);
}

/**
 * Moves the purchase from `proposed` to `charging`, with the policy as its approver, logs the
 * charge and queues its `charge_retry` job with recordCharge, and returns the charge to send. If
 * chargeRefusal refuses the purchase, it fails with a `charge_refused` event saying why, and if its
 * buyer has no linked wallet, with a `charge_failed` event. Either way it returns null, and it also
 * returns null for a purchase another call has already moved on.
 */
async function startCharge(
  { db, now }: ChargeDeps,
  purchaseId: string,
  buyerId: string,
  totalCents: number,
): Promise<ChargeRequest | null> {
  try {
    return await db.transaction(async (tx) => {
      await transition(tx, purchaseId, 'proposed', 'charging', { approver: 'policy' });
      const refusal = await chargeRefusal(tx, purchaseId, now());
      if (refusal) {
        await appendEvent(tx, purchaseId, 'charge_refused', { reason: refusal });
        await transition(tx, purchaseId, 'charging', 'failed');
        return null;
      }
      const paymentTokenId = await linkedPaymentToken(tx, buyerId);
      if (!paymentTokenId) {
        await appendEvent(tx, purchaseId, 'charge_failed', { reason: NO_WALLET });
        await transition(tx, purchaseId, 'charging', 'failed');
        return null;
      }
      const request = chargeRequest(purchaseId, paymentTokenId, totalCents);
      await recordCharge(tx, purchaseId, request, now());
      return request;
    });
  } catch (error) {
    if (error instanceof StaleTransition) return null;
    throw error;
  }
}

function chargeRequest(purchaseId: string, paymentTokenId: string, amountCents: number): ChargeRequest {
  return {
    paymentTokenId,
    amountCents,
    description: `Behest order ${purchaseId}`,
    invoiceId: purchaseId,
    requestId: `${purchaseId}:charge`,
  };
}

/** Asks PayPal for the payment, and once more if that throws. Both carry the same request id, so PayPal takes the money at most once. */
async function sendPayment(paypal: PaypalPort, request: PaymentRequest): Promise<PaymentAnswer> {
  try {
    return await askPaypal(paypal, request);
  } catch {
    return askPaypal(paypal, request);
  }
}

/** Sends the payment request once. PayPal's refusal to capture an unapproved order is an answer, not an error: nothing moved. */
async function askPaypal(paypal: PaypalPort, request: PaymentRequest): Promise<PaymentAnswer> {
  if ('paymentTokenId' in request) return paypal.chargeSavedWallet(request);
  const { orderId, requestId } = request;
  try {
    return { orderId, ...(await paypal.captureOrder(orderId, requestId)) };
  } catch (error) {
    if (isOrderNotApproved(error)) return { orderId, status: 'NOT_APPROVED' };
    throw error;
  }
}

/** Acts on PayPal's answer to a payment, from takePayment or its replay, and returns where the purchase then stands. */
async function applyAnswer(deps: ChargeDeps, purchaseId: string, requestId: string, answer: PaymentAnswer): Promise<ProposalOutcome> {
  const { db } = deps;
  switch (answer.status) {
    case 'COMPLETED':
      return completeCapture(deps, purchaseId, { orderId: answer.orderId, captureId: answer.captureId });
    case 'PENDING':
      await recordPendingCapture(db, purchaseId, { orderId: answer.orderId, captureId: answer.captureId });
      return purchaseOutcome(db, purchaseId);
    case 'DECLINED':
      await recordDecline(db, purchaseId, requestId);
      return purchaseOutcome(db, purchaseId);
    case 'NOT_APPROVED':
      await reopenApproval(db, purchaseId, { orderId: answer.orderId, requestId }, deps.now());
      return purchaseOutcome(db, purchaseId);
  }
}

/**
 * Stores the ids of a capture PayPal is holding and logs `capture_pending`, leaving the purchase
 * `charging`. Only the first report is stored, and only while the purchase is still `charging`, or
 * `awaiting_approval` for a capture of its own approval order (see approvedSinceReopen), which first
 * moves it back to `charging` with the buyer as its approver. The purchase row is locked while the
 * report is checked and stored. The capture already stored, reported again, is a quiet no-op. Any
 * other capture that does not fit, such as one for a cancelled purchase or for another order, is
 * logged as `capture_unmatched` for an operator, since PayPal may yet complete it.
 */
async function recordPendingCapture(db: Db, purchaseId: string, { orderId, captureId }: Capture): Promise<void> {
  await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status, orderId: purchases.paypalOrderId, captureId: purchases.paypalCaptureId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (!purchase) throw new Error(`there is no purchase ${purchaseId}`);
    if (purchase.captureId === captureId) return;
    const approvedSince = approvedSinceReopen(purchase, orderId);
    const fitsCharging = purchase.status === 'charging' && purchase.captureId === null && (purchase.orderId ?? orderId) === orderId;
    if (!approvedSince && !fitsCharging) {
      await appendEvent(tx, purchaseId, 'capture_unmatched', { captureId });
      return;
    }
    if (approvedSince) await transition(tx, purchaseId, 'awaiting_approval', 'charging', { approver: 'human' });
    await tx.update(purchases).set({ paypalOrderId: orderId, paypalCaptureId: captureId }).where(eq(purchases.id, purchaseId));
    await appendEvent(tx, purchaseId, 'capture_pending', { orderId, captureId });
  });
}

/** Fails a purchase PayPal declined to charge. Nothing moved, so its budget is released. */
async function recordDecline(db: Db, purchaseId: string, requestId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await appendEvent(tx, purchaseId, 'charge_declined', { requestId });
      await transition(tx, purchaseId, 'charging', 'failed');
    });
  } catch (error) {
    // Another call has already acted on PayPal's answer.
    if (!(error instanceof StaleTransition)) throw error;
  }
}

/**
 * Whether a capture of `orderId` reported for a purchase `awaiting_approval` is of the purchase's own
 * approval order, with no capture recorded yet. That happens when a replay of the capture overlapped
 * the call PayPal told the order was not approved: the replay found the purchase `charging`, and the
 * buyer approved before PayPal captured for it, so the money is the purchase's own.
 */
function approvedSinceReopen(
  purchase: { status: PurchaseStatus; orderId: string | null; captureId: string | null },
  orderId: string,
): boolean {
  return purchase.status === 'awaiting_approval' && purchase.orderId === orderId && purchase.captureId === null;
}

/** The `approval_order` event's record of when the purchase's approval window closes, if any. */
const ApprovalWindow = z.object({ expiresAt: z.iso.datetime() });

/**
 * Sends a purchase whose order PayPal would not capture, because its buyer has not approved it, back
 * to `awaiting_approval` for them to approve, logging `approval_pending`. No money moved, and the
 * approval link stays on the purchase. The purchase is locked, and only one still `charging` with no
 * capture recorded goes back, so a capture another call has recorded meanwhile is never set aside.
 * It also queues a fresh `approval_expiry` job, due when the approval window recorded with the order
 * closes, or now if that has passed: the first expiry may already have run while the purchase was
 * `charging`, and done nothing.
 */
async function reopenApproval(db: Db, purchaseId: string, { orderId, requestId }: CaptureRequest, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status, captureId: purchases.paypalCaptureId })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    if (purchase?.status !== 'charging' || purchase.captureId !== null) return;
    await appendEvent(tx, purchaseId, 'approval_pending', { orderId, requestId });
    await transition(tx, purchaseId, 'charging', 'awaiting_approval', { approver: null });
    const [order] = await tx
      .select({ data: purchaseEvents.data })
      .from(purchaseEvents)
      .where(and(eq(purchaseEvents.purchaseId, purchaseId), eq(purchaseEvents.kind, 'approval_order')))
      .limit(1);
    // Every approval order is recorded with its window. Were one not, the purchase expires now.
    const recorded = ApprovalWindow.safeParse(order?.data);
    const closes = recorded.success ? Date.parse(recorded.data.expiresAt) : now.getTime();
    await enqueue(tx, 'approval_expiry', { purchaseId }, new Date(Math.max(now.getTime(), closes)));
  });
}

/** The payment token of the buyer's linked wallet, or null if they have none. */
async function linkedPaymentToken(db: Db, buyerId: string): Promise<string | null> {
  const [wallet] = await db
    .select({ paymentTokenId: wallets.paymentTokenId })
    .from(wallets)
    .where(and(eq(wallets.buyerId, buyerId), eq(wallets.status, 'linked'), isNotNull(wallets.paymentTokenId)));
  return wallet?.paymentTokenId ?? null;
}

/** The purchase's payment as its first `charge` event recorded it, or null if it has none. */
async function sentPayment(db: Db, purchaseId: string): Promise<SentPayment | null> {
  const [charge] = await db
    .select({ data: purchaseEvents.data })
    .from(purchaseEvents)
    .where(and(eq(purchaseEvents.purchaseId, purchaseId), eq(purchaseEvents.kind, 'charge')))
    .orderBy(asc(purchaseEvents.seq))
    .limit(1);
  const parsed = SentPayment.safeParse(charge?.data);
  return parsed.success ? parsed.data : null;
}
