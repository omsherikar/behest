import { and, eq, isNull } from 'drizzle-orm';
import { webhookEvents } from '@/lib/db/schema';
import { syncDisputes } from '@/lib/disputes/sync';
import { handleWebhook } from '@/lib/paypal/webhook-handler';
import { expireApproval } from '@/lib/purchases/approval';
import { retryCharge } from '@/lib/purchases/charge';
import type { PurchaseDeps } from '@/lib/purchases/deps';
import { pollPayout } from '@/lib/purchases/settle';
import type { JobHandlers, JobKind, JobOutcome, JobPayload } from './queue';

// The handler for every job kind, each a thin call into the flow that owns the work. Every one of
// those flows is idempotent and safe to overlap with itself, as the queue requires.

/** What the job handlers and the periodic pass need: PayPal, the database, the signer, the sellers and the clock. */
export type JobDeps = Pick<PurchaseDeps, 'db' | 'paypal' | 'signer' | 'sellers' | 'now'>;

/** The payload's string `field`. Throws, naming the job kind, when it has none. */
function field(kind: JobKind, payload: JobPayload, name: 'purchaseId' | 'eventId'): string {
  const value = payload[name];
  if (typeof value !== 'string' || !value) throw new Error(`a ${kind} job needs a ${name}`);
  return value;
}

/**
 * Handles the stored PayPal webhook event `eventId` and marks it processed. An event already marked
 * processed is a quiet done. Throws, so the job runs again, for an event that is not stored or that
 * handleWebhook could not handle; the event then stays unprocessed.
 */
async function processWebhook(deps: JobDeps, eventId: string): Promise<JobOutcome> {
  const { db } = deps;
  const [event] = await db
    .select({ payload: webhookEvents.payload, processedAt: webhookEvents.processedAt })
    .from(webhookEvents)
    .where(eq(webhookEvents.eventId, eventId));
  if (!event) throw new Error(`there is no stored PayPal webhook event ${eventId}`);
  if (event.processedAt) return 'done';
  await handleWebhook(deps, event.payload);
  await db
    .update(webhookEvents)
    .set({ processedAt: deps.now() })
    .where(and(eq(webhookEvents.eventId, eventId), isNull(webhookEvents.processedAt)));
  return 'done';
}

export const jobHandlers: JobHandlers<JobDeps> = {
  payout_poll: async (payload, deps) => pollPayout(deps, field('payout_poll', payload, 'purchaseId')),
  approval_expiry: async (payload, deps) => expireApproval(deps, field('approval_expiry', payload, 'purchaseId')),
  dispute_sync: async (_, deps) => {
    await syncDisputes(deps);
    return 'done';
  },
  webhook: async (payload, deps) => processWebhook(deps, field('webhook', payload, 'eventId')),
  charge_retry: async (payload, deps) => retryCharge(deps, field('charge_retry', payload, 'purchaseId')),
};
