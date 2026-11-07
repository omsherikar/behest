import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { jobs, payouts, purchases, refunds } from '@/lib/db/schema';
import { firstProblem } from '@/lib/http/problem';
import { enqueue, type JobKind, type JobPayload } from '@/lib/jobs/queue';
import { completeApproval } from '@/lib/purchases/approval';
import { completeCapture } from '@/lib/purchases/charge';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { appendEvent, transition } from '@/lib/purchases/events';
import { canTransition } from '@/lib/purchases/transitions';
import { toCents } from './money';

// Acting on a PayPal webhook event that has been verified and stored (see the webhooks route). Each
// event moves only the purchase it names: by the order, capture or payout batch Behest stored for it,
// or, for a capture whose answer Behest never recorded, by the invoice id Behest sent, which is the
// purchase id, together with the order Behest stored. An event that names nothing Behest holds is
// logged and left alone. An event that arrives before Behest has recorded what it is about, such as
// a capture of a charge still being recorded or a refund while Behest's own refund awaits PayPal's
// answer, throws, so its job runs again once that is recorded. An event of a type Behest does not
// act on is quietly done.
//
// Handling the same event again changes nothing: every branch acts only from the state the first
// handling left behind, and a job it asks for is queued once. Money moves only through the purchase
// flow's own capture and payout steps, which are idempotent; nothing here ever refunds, and a payout's
// status is recorded only by its poll. No database lock is held while PayPal is asked. A verified
// event Behest cannot read throws, so its job ends visibly dead after its retries.

export type WebhookDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'signer' | 'sellers' | 'now'>;

/** The event as it is named in logs. */
type Seen = { id: string; type: string };

const Envelope = z.object({ id: z.string().min(1), event_type: z.string().min(1), resource: z.unknown() });

const OrderResource = z.object({ id: z.string().min(1) });

const CaptureResource = z.object({
  id: z.string().min(1),
  invoice_id: z.string().optional(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().min(1).optional() }).optional() }).optional(),
});

const RefundResource = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  amount: z.object({ currency_code: z.literal('USD'), value: z.string() }),
  links: z.array(z.object({ rel: z.string().optional(), href: z.string().optional() })),
});

const PayoutItemResource = z.object({ payout_batch_id: z.string().min(1) });

/** Every dispute event, whatever happened to the dispute, asks for a dispute sync. */
const DISPUTE_EVENTS = 'CUSTOMER.DISPUTE.';
/** Every payout item event, whatever happened to the item, asks for its payout's poll. */
const PAYOUT_ITEM_EVENTS = 'PAYMENT.PAYOUTS-ITEM.';

/** A refund's link to the capture it refunds: `/v2/payments/captures/{captureId}`. */
const CAPTURE_PATH = /^\/v2\/payments\/captures\/([^/]+)$/;

/** Refund statuses with which PayPal has returned, or is returning, the buyer's money. */
const REFUNDING: ReadonlySet<string> = new Set(['COMPLETED', 'PENDING']);

/**
 * Acts on one verified PayPal webhook event, by its `event_type`:
 * - CHECKOUT.ORDER.APPROVED: captures an approved order with completeApproval;
 * - PAYMENT.CAPTURE.COMPLETED: records the capture with completeCapture, so the receipt and the
 *   delivery follow;
 * - PAYMENT.CAPTURE.DENIED: fails a `charging` purchase holding the capture;
 * - PAYMENT.CAPTURE.REFUNDED: records a refund made outside Behest;
 * - PAYMENT.CAPTURE.REVERSED: records PayPal taking the payment back, as a full refund;
 * - any CUSTOMER.DISPUTE. event: queues a `dispute_sync`, which reads the dispute from PayPal;
 * - any PAYMENT.PAYOUTS-ITEM. event: queues the payout's `payout_poll`, which decides.
 * Any other type is done with nothing changed. Throws for an event with no id or type, a resource
 * missing what its type needs, or an event about something Behest has not finished recording.
 */
export async function handleWebhook(deps: WebhookDeps, event: Record<string, unknown>): Promise<void> {
  const envelope = Envelope.safeParse(event);
  if (!envelope.success) throw new Error('a PayPal webhook event with no id or event type cannot be handled');
  const { id, event_type: type, resource } = envelope.data;
  const seen = { id, type };
  switch (type) {
    case 'CHECKOUT.ORDER.APPROVED':
      return orderApproved(deps, seen, readResource(OrderResource, seen, resource).id);
    case 'PAYMENT.CAPTURE.COMPLETED':
      return captureCompleted(deps, seen, readResource(CaptureResource, seen, resource));
    case 'PAYMENT.CAPTURE.DENIED':
      return captureDenied(deps.db, seen, readResource(CaptureResource, seen, resource));
    case 'PAYMENT.CAPTURE.REFUNDED':
      return captureRefunded(deps.db, seen, readResource(RefundResource, seen, resource), 'refund');
    case 'PAYMENT.CAPTURE.REVERSED':
      return captureRefunded(deps.db, seen, readResource(RefundResource, seen, resource), 'reversal');
  }
  if (type.startsWith(DISPUTE_EVENTS)) return queueDue(deps.db, 'dispute_sync', {}, deps.now());
  if (type.startsWith(PAYOUT_ITEM_EVENTS)) {
    return payoutItem(deps, seen, readResource(PayoutItemResource, seen, resource).payout_batch_id);
  }
}

/** The event's resource as `schema` reads it. Throws, naming what is missing, if it does not fit. */
function readResource<T>(schema: z.ZodType<T>, { id, type }: Seen, resource: unknown): T {
  const parsed = schema.safeParse(resource);
  if (!parsed.success) throw new Error(`PayPal webhook ${id} (${type}) cannot be handled: ${firstProblem(parsed.error)}`);
  return parsed.data;
}

/** The error for an event Behest cannot act on until it has recorded `what`; its job runs again. */
function notYetRecorded({ id, type }: Seen, what: string): Error {
  return new Error(`PayPal webhook ${id} (${type}) waits until ${what}, so it is handled again later`);
}

/** Logs, once, why an event names nothing Behest can act on. */
function ignore({ id, type }: Seen, why: string): void {
  console.warn(`PayPal webhook ${id} (${type}) is ignored: ${why}`);
}

/**
 * The buyer approved an order at PayPal. Only a purchase its buyer approves at PayPal (final verdict
 * ASK) that holds the order and is `awaiting_approval`, or `charging` with no capture, is passed to
 * completeApproval. That captures only a purchase still `awaiting_approval`; one already `charging`
 * is left as it is, for its `charge_retry` replay. A saved-wallet charge's order is never touched,
 * nor a purchase that has moved on. completeApproval locks the purchase itself, so an approval
 * racing the buyer's return from PayPal still captures once.
 */
async function orderApproved(deps: WebhookDeps, seen: Seen, orderId: string): Promise<void> {
  const [purchase] = await deps.db
    .select({ status: purchases.status, finalVerdict: purchases.finalVerdict, captureId: purchases.paypalCaptureId })
    .from(purchases)
    .where(eq(purchases.paypalOrderId, orderId));
  if (!purchase) return ignore(seen, `no purchase holds order ${orderId}`);
  if (purchase.finalVerdict !== 'ASK') return;
  const approvable = purchase.status === 'awaiting_approval' || (purchase.status === 'charging' && purchase.captureId === null);
  if (approvable) await completeApproval(deps, orderId);
}

/**
 * PayPal completed a capture. The purchase is the one holding the capture id, such as a saved-wallet
 * charge PayPal held as PENDING, as long as the event names no other order than the one it holds.
 * Failing that, it is the purchase named by the capture's invoice id while it is `charging` with no
 * capture recorded and holds the capture's order. completeCapture then records the capture, under
 * the purchase lock, issues the receipt and delivers the order; a capture it has already recorded is
 * a quiet no-op. When the invoice names a purchase still `charging` with no capture recorded but under
 * no order, or another one, its charge is still being recorded, so this throws and the job runs again
 * after the charge's replay has stored the capture. An invoice naming no such purchase is logged.
 */
async function captureCompleted(deps: WebhookDeps, seen: Seen, capture: z.infer<typeof CaptureResource>): Promise<void> {
  const { id: captureId, invoice_id: invoiceId } = capture;
  const eventOrderId = capture.supplementary_data?.related_ids?.order_id;
  const holder = await purchaseHolding(deps.db, captureId);
  if (holder) {
    const orderId = holder.orderId ?? eventOrderId;
    if (!orderId || (eventOrderId !== undefined && eventOrderId !== orderId)) {
      return ignore(seen, `purchase ${holder.id} holds capture ${captureId}, but not under the order the event names`);
    }
    await completeCapture(deps, holder.id, { orderId, captureId });
    return;
  }
  const charging = await chargingFor(deps.db, invoiceId);
  if (!charging) return ignore(seen, `no purchase holds capture ${captureId}, and its invoice names no purchase still charging`);
  if (!eventOrderId || charging.orderId !== eventOrderId) {
    throw notYetRecorded(seen, `purchase ${charging.id}, still charging, has recorded capture ${captureId}`);
  }
  await completeCapture(deps, charging.id, { orderId: eventOrderId, captureId });
}

/**
 * The purchase the invoice id names, with the order it holds, if it is `charging` with no capture
 * recorded. A saved-wallet charge whose answer has not been recorded holds no order yet.
 */
async function chargingFor(db: Db, invoiceId: string | undefined): Promise<{ id: string; orderId: string | null } | null> {
  // Behest's invoice id is the purchase id; anything else is not one of its purchases.
  const purchaseId = z.uuid().safeParse(invoiceId);
  if (!purchaseId.success) return null;
  const [purchase] = await db
    .select({ id: purchases.id, orderId: purchases.paypalOrderId })
    .from(purchases)
    .where(and(eq(purchases.id, purchaseId.data), eq(purchases.status, 'charging'), isNull(purchases.paypalCaptureId)));
  return purchase ?? null;
}

/**
 * PayPal denied a capture it was holding, so no money moved. With the purchase locked, a `charging`
 * purchase holding the capture logs `capture_denied` and fails, releasing its budget. Any other
 * purchase is left as it is. When no purchase holds the capture yet but its invoice names one still
 * `charging` with no capture recorded, its charge is still being recorded, so this throws and the
 * job runs again after the charge's replay has stored the capture.
 */
async function captureDenied(db: Db, seen: Seen, capture: z.infer<typeof CaptureResource>): Promise<void> {
  const { id: captureId, invoice_id: invoiceId } = capture;
  const holder = await purchaseHolding(db, captureId);
  if (!holder) {
    const charging = await chargingFor(db, invoiceId);
    if (charging) throw notYetRecorded(seen, `purchase ${charging.id}, still charging, has recorded capture ${captureId}`);
    return ignore(seen, `no purchase holds capture ${captureId}`);
  }
  await db.transaction(async (tx) => {
    const [purchase] = await tx.select({ status: purchases.status }).from(purchases).where(eq(purchases.id, holder.id)).for('update');
    if (purchase.status !== 'charging') return;
    await appendEvent(tx, holder.id, 'capture_denied', { captureId });
    await transition(tx, holder.id, 'charging', 'failed');
  });
}

/**
 * PayPal returned money from a capture: a refund made at PayPal itself, by a dispute decision or by
 * Behest, or a reversal, where PayPal took the payment back, such as after a lost chargeback. Either
 * is recorded with recordRefund, which never refunds anything.
 */
async function captureRefunded(
  db: Db,
  seen: Seen,
  refund: z.infer<typeof RefundResource>,
  kind: 'refund' | 'reversal',
): Promise<void> {
  const captureId = refundedCapture(refund.links);
  if (!captureId) throw new Error(`PayPal webhook ${seen.id} (${seen.type}) cannot be handled: the refund names no capture`);
  const amountCents = toCents(refund.amount.value);
  const holder = await purchaseHolding(db, captureId);
  if (!holder) return ignore(seen, `no purchase holds capture ${captureId}`);
  await recordRefund(db, seen, holder.id, { refundId: refund.id, status: refund.status, amountCents }, kind);
}

/**
 * Records money PayPal returned from a purchase's capture, with the purchase row locked and its
 * payout read, so it cannot interleave with Behest's own refund or payout of the purchase. A refund
 * already recorded under PayPal's id, Behest's own included, is a quiet no-op. While Behest's own
 * refund of the purchase awaits PayPal's answer (its refunds row has no PayPal id yet), this throws,
 * naming the purchase and that row, so the job runs again: the refund flow, or the periodic pass's
 * retry under the same request id, records the answer first, and only then can this event be told
 * apart from it. Otherwise it writes the refunds row and logs `refund_external` for a refund or
 * `capture_reversed` for a reversal, saying whether the seller's payout was made. It moves the
 * purchase to `refunded` where the lifecycle allows, from `captured`, `accepted`, `settled` or
 * `disputed`: at once for a reversal, which takes the whole payment back, and for refunds once they
 * reach the purchase's total. A partial refund leaves the rest counted against the budget.
 */
async function recordRefund(
  db: Db,
  seen: Seen,
  purchaseId: string,
  refund: { refundId: string; status: string; amountCents: number },
  kind: 'refund' | 'reversal',
): Promise<void> {
  await db.transaction(async (tx) => {
    const [purchase] = await tx
      .select({ status: purchases.status, totalCents: purchases.totalCents })
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .for('update');
    const [payout] = await tx.select({ status: payouts.status }).from(payouts).where(eq(payouts.purchaseId, purchaseId));
    const recorded = await tx
      .select({ id: refunds.id, paypalRefundId: refunds.paypalRefundId, amountCents: refunds.amountCents, status: refunds.status })
      .from(refunds)
      .where(eq(refunds.purchaseId, purchaseId));
    if (recorded.some((row) => row.paypalRefundId === refund.refundId)) return;
    const pending = recorded.find((row) => row.paypalRefundId === null);
    if (pending) throw notYetRecorded(seen, `Behest's own refund ${pending.id} of purchase ${purchaseId} has PayPal's answer`);

    const { refundId, status, amountCents } = refund;
    await tx.insert(refunds).values({ purchaseId, amountCents, paypalRefundId: refundId, status });
    await appendEvent(tx, purchaseId, kind === 'refund' ? 'refund_external' : 'capture_reversed', {
      refundId,
      status,
      amountCents,
      payoutStatus: payout?.status ?? null,
    });

    const refundedCents = [...recorded, refund]
      .filter((row) => REFUNDING.has(row.status))
      .reduce((sum, row) => sum + row.amountCents, 0);
    const whole = kind === 'reversal' || (purchase.totalCents !== null && refundedCents >= purchase.totalCents);
    if (whole && canTransition(purchase.status, 'refunded')) await transition(tx, purchaseId, purchase.status, 'refunded');
  });
}

/** The capture a refund's `up` link points to, or null when it has none. */
function refundedCapture(links: z.infer<typeof RefundResource>['links']): string | null {
  for (const { rel, href } of links) {
    if (rel !== 'up' || !href) continue;
    const match = CAPTURE_PATH.exec(URL.parse(href)?.pathname ?? '');
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

/** PayPal reports a payout item finished. The payout's poll asks PayPal and records what it finds. */
async function payoutItem(deps: WebhookDeps, seen: Seen, payoutBatchId: string): Promise<void> {
  const [payout] = await deps.db
    .select({ purchaseId: payouts.purchaseId })
    .from(payouts)
    .where(eq(payouts.paypalBatchId, payoutBatchId))
    .limit(1);
  if (!payout) return ignore(seen, `no payout holds batch ${payoutBatchId}`);
  await queueDue(deps.db, 'payout_poll', { purchaseId: payout.purchaseId }, deps.now());
}

/**
 * The purchase holding a PayPal capture, with its order. Null when none does, or when more than one
 * does, since then the capture names no one purchase.
 */
async function purchaseHolding(db: Db, captureId: string): Promise<{ id: string; orderId: string | null } | null> {
  const holders = await db
    .select({ id: purchases.id, orderId: purchases.paypalOrderId })
    .from(purchases)
    .where(eq(purchases.paypalCaptureId, captureId))
    .limit(2);
  return holders.length === 1 ? holders[0] : null;
}

/**
 * Makes sure a job of `kind` with exactly `payload` is due by `now`: one already queued is brought
 * forward if it is due later, and otherwise one is queued. So an event handled twice queues one job.
 */
async function queueDue(db: Db, kind: JobKind, payload: JobPayload, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select({ id: jobs.id, runAt: jobs.runAt })
      .from(jobs)
      .where(and(eq(jobs.kind, kind), eq(jobs.status, 'queued'), sql`${jobs.payload} = ${JSON.stringify(payload)}::jsonb`))
      .limit(1)
      .for('update');
    if (!job) {
      await enqueue(tx, kind, payload, now);
      return;
    }
    if (job.runAt > now) await tx.update(jobs).set({ runAt: now }).where(eq(jobs.id, job.id));
  });
}
