import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { purchaseEvents, purchases, receipts, wallets } from '@/lib/db/schema';
import { enqueue, type JobOutcome } from '@/lib/jobs/queue';
import type { PaypalPort } from '@/lib/paypal/port';
import { deliverToSeller } from './deliver';
import type { ProposalOutcome, PurchaseDeps } from './deps';
import { appendEvent, StaleTransition, transition } from './events';
import { issueReceipt, receiptBlocker } from './receipt';
import { describeFailure } from './settle';

// Charging an allowed purchase (architecture section 6.2). The gate allowed it, so Behest charges
// the buyer's saved PayPal wallet with no buyer present, signs a receipt for the captured payment
// and hands the order to the seller.
//
// Every charge of a purchase carries the request id `${purchaseId}:charge`, so PayPal answers a
// repeat with the first result and never charges twice. Only a DECLINED answer means no money
// moved. Any error may follow a charge PayPal carried out, so the purchase then stays `charging`,
// still counted against the budget, until a replay under the same request id finds out. That replay
// is queued as a `charge_retry` job before PayPal is first asked, so a charge whose answer is never
// recorded, because the process stopped or the database failed, is still followed up. No database
// lock is held while PayPal is asked.

type ChargeDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'signer' | 'sellers' | 'now'>;
type ChargeRequest = Parameters<PaypalPort['chargeSavedWallet']>[0];
type ChargeAnswer = Awaited<ReturnType<PaypalPort['chargeSavedWallet']>>;
type Capture = { orderId: string; captureId: string };

const NO_WALLET = 'The buyer has no linked PayPal wallet.';

/**
 * A `charge` event's data: the request exactly as sent to PayPal, so a replay can send the same
 * bytes, and when it was first sent, on the app's clock, the one the replay window is measured on.
 */
const SentCharge = z.object({
  paymentTokenId: z.string().min(1),
  amountCents: z.number().int().positive(),
  description: z.string().min(1),
  invoiceId: z.string().min(1),
  requestId: z.string().min(1),
  startedAt: z.iso.datetime(),
});
type SentCharge = z.infer<typeof SentCharge>;

/**
 * How long after a charge starts its `charge_retry` job first runs. By then a charge that went
 * normally has long been recorded, and the job finds nothing to do.
 */
const CHARGE_RETRY_DELAY_MS = 2 * 60 * 1000;

/**
 * The longest after its first attempt that a charge is replayed. PayPal keeps the request id of an
 * order created with a saved wallet for 6 hours; after that the same id would create a new order
 * and charge the buyer again. The replay stops an hour short of that.
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
 * A purchase that could not be given its receipt once captured fails with a `charge_refused` event,
 * and one whose buyer has no linked wallet with a `charge_failed` event, each saying why; PayPal is
 * never asked. A purchase another call has already moved on from `proposed` is returned
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

  let answer: ChargeAnswer;
  try {
    answer = await sendCharge(deps.paypal, request);
  } catch (error) {
    // The job queued with the charge replays it; one job per charge is enough.
    await appendEvent(db, purchaseId, 'charge_unknown', { requestId: request.requestId, ...describeFailure(error) });
    return purchaseOutcome(db, purchaseId);
  }
  return applyAnswer(deps, purchaseId, request.requestId, answer);
}

/**
 * Replays the charge of a purchase whose charge was never recorded: the handler of the
 * `charge_retry` job queued with every charge. It sends exactly the request its `charge` event
 * recorded, payment token and request id included, so PayPal either reports the charge it already
 * made or makes it now, and goes on as chargeAllowed does with the
 * answer; that is safe even while another call acts on the same answer. `done` once PayPal has
 * answered, and also, without asking PayPal, for a purchase no longer `charging` or one whose
 * capture is pending, which only PayPal's webhook can move on. Throws, so the job is retried with
 * backoff, while PayPal still cannot answer. Also throws, without asking PayPal, for a purchase
 * with no saved-wallet charge to replay, one charged too long ago to replay safely, or one whose
 * buyer has no linked wallet any more: money may have moved, so an operator checks PayPal.
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

  const sent = await sentCharge(db, purchaseId);
  if (!sent) throw new Error(`purchase ${purchaseId} has no saved-wallet charge to replay`);
  const { startedAt, ...request } = sent;
  if (deps.now().getTime() - Date.parse(startedAt) > REPLAY_WINDOW_MS) {
    throw new Error(`the charge of purchase ${purchaseId} is too old to replay safely; check PayPal before charging again`);
  }
  // The replay sends the token the charge was sent with, but only while the buyer still has a
  // linked wallet: one who has unlinked it since must not be charged by a request PayPal never got.
  if (!(await linkedPaymentToken(db, purchase.buyerId))) {
    throw new Error(
      `the buyer of purchase ${purchaseId} has no linked wallet any more, so its charge is not replayed; check PayPal`,
    );
  }

  await applyAnswer(deps, purchaseId, request.requestId, await sendCharge(deps.paypal, request));
  return 'done';
}

/**
 * Takes a `charging` purchase whose PayPal capture has COMPLETED to its receipt and delivery:
 * records the capture's ids and time with a `capture` event and moves the purchase to `captured`,
 * then issues the receipt and hands the order to the seller. Used by the charge, its retry, and
 * PayPal's webhook for a capture that was pending. The purchase row is locked while the capture is
 * checked and recorded, so only one call records it and goes on; a capture reported again is a
 * quiet no-op. A capture that does not fit the purchase, because the purchase is not `charging` or
 * already holds other PayPal ids, is never recorded over them: it is logged as `capture_unmatched`
 * for an operator, since PayPal holds money the purchase does not account for. Either way the
 * purchase is returned as it stands.
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
    const fits =
      purchase.status === 'charging' &&
      (purchase.captureId ?? captureId) === captureId &&
      (purchase.orderId ?? orderId) === orderId;
    if (!fits) {
      await appendEvent(tx, purchaseId, 'capture_unmatched', { captureId });
      return false;
    }
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
 * Moves the purchase from `proposed` to `charging`, with the policy as its approver, logs the
 * charge and queues its `charge_retry` job, and returns the charge to send. If the purchase could
 * not be given its receipt, or its buyer has no linked wallet, it fails the purchase instead, and
 * returns null; it also returns null for a purchase another call has already moved on.
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
      const refusal = await receiptBlocker(tx, purchaseId, now());
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
      await appendEvent(tx, purchaseId, 'charge', { ...request, startedAt: now().toISOString() } satisfies SentCharge);
      await enqueue(tx, 'charge_retry', { purchaseId }, new Date(now().getTime() + CHARGE_RETRY_DELAY_MS));
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

/** Asks PayPal for the charge, and once more if that throws. Both carry the same request id, so PayPal charges at most once. */
async function sendCharge(paypal: PaypalPort, request: ChargeRequest): Promise<ChargeAnswer> {
  try {
    return await paypal.chargeSavedWallet(request);
  } catch {
    return paypal.chargeSavedWallet(request);
  }
}

/** Acts on PayPal's answer to a charge, from chargeAllowed or its replay, and returns where the purchase then stands. */
async function applyAnswer(deps: ChargeDeps, purchaseId: string, requestId: string, answer: ChargeAnswer): Promise<ProposalOutcome> {
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
  }
}

/**
 * Stores the ids of a capture PayPal is holding and logs `capture_pending`, leaving the purchase
 * `charging`. Only the first report is stored, and only while the purchase is still `charging`.
 */
async function recordPendingCapture(db: Db, purchaseId: string, { orderId, captureId }: Capture): Promise<void> {
  await db.transaction(async (tx) => {
    const stored = await tx
      .update(purchases)
      .set({ paypalOrderId: orderId, paypalCaptureId: captureId })
      .where(and(eq(purchases.id, purchaseId), eq(purchases.status, 'charging'), isNull(purchases.paypalCaptureId)))
      .returning({ id: purchases.id });
    if (stored.length > 0) await appendEvent(tx, purchaseId, 'capture_pending', { orderId, captureId });
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

/** The payment token of the buyer's linked wallet, or null if they have none. */
async function linkedPaymentToken(db: Db, buyerId: string): Promise<string | null> {
  const [wallet] = await db
    .select({ paymentTokenId: wallets.paymentTokenId })
    .from(wallets)
    .where(and(eq(wallets.buyerId, buyerId), eq(wallets.status, 'linked'), isNotNull(wallets.paymentTokenId)));
  return wallet?.paymentTokenId ?? null;
}

/** The purchase's saved-wallet charge as its `charge` event recorded it, or null if it has none. */
async function sentCharge(db: Db, purchaseId: string): Promise<SentCharge | null> {
  const [charge] = await db
    .select({ data: purchaseEvents.data })
    .from(purchaseEvents)
    .where(and(eq(purchaseEvents.purchaseId, purchaseId), eq(purchaseEvents.kind, 'charge')))
    .orderBy(asc(purchaseEvents.seq))
    .limit(1);
  const parsed = SentCharge.safeParse(charge?.data);
  return parsed.success ? parsed.data : null;
}
