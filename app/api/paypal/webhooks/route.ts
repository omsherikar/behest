import { connection, type NextRequest } from 'next/server';
import { appDb, appPaypal } from '@/lib/app-deps';
import { webhookEvents } from '@/lib/db/schema';
import { readBody } from '@/lib/http/read-body';
import { enqueue } from '@/lib/jobs/queue';
import { clientAddress, PUBLIC_WRITE_LIMIT, rateLimit } from '@/lib/ratelimit';

// Where PayPal delivers webhook events, open to anyone, so nothing is believed until PayPal itself
// verifies it. A verified event is stored under PayPal's event id and its `webhook` job queued in the
// same transaction, then acknowledged. The job acts on it later (see lib/paypal/webhook-handler.ts),
// so a slow purchase flow never makes PayPal retry. PayPal delivers an event again until it gets a
// 2xx, and a delivery whose event id is already stored is acknowledged without storing or queuing it
// twice. A rejection is logged by its reason only, never with the body, which can carry buyer details.

const ROUTE = 'paypal_webhooks';

/** PayPal's events are a few kilobytes. Anything this large is not one of them. */
const WEBHOOK_BODY_BYTES = 256 * 1024;

const NOT_VERIFIED = 'The event could not be verified as coming from PayPal.';

type Rejection = 'too_large' | 'unverified' | 'malformed';
type StoredEvent = Record<string, unknown> & { id: string; event_type: string };

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

function reject(status: number, reason: Rejection, message: string): Response {
  console.warn(`Rejected a PayPal webhook (${reason})`);
  return error(status, message);
}

/** The event in a verified body, or null when it is not a JSON object with an id and an event type. */
function parseEvent(raw: string): StoredEvent | null {
  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return null;
  const { id, event_type: eventType } = event as Record<string, unknown>;
  return typeof id === 'string' && id && typeof eventType === 'string' && eventType ? (event as StoredEvent) : null;
}

/**
 * `POST`: a PayPal webhook event. 200 `{ received: true }` once the event is stored and queued, or
 * was already. 400 for an event PayPal does not verify, or that has no id or event type, and also
 * when PAYPAL_WEBHOOK_ID is not set, since then nothing can be verified. 413 for a body over 256 KiB
 * and 429 past the public write limit. Only a 200 stores anything.
 */
export async function POST(request: NextRequest) {
  // Writes to the database on every request, never at build time.
  await connection();

  if (!rateLimit(`${ROUTE}:${clientAddress(request)}`, PUBLIC_WRITE_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }
  if (!process.env.PAYPAL_WEBHOOK_ID) {
    console.error('Rejected a PayPal webhook (configuration): PAYPAL_WEBHOOK_ID is not set, so no event can be verified');
    return error(400, NOT_VERIFIED);
  }

  const raw = await readBody(request, WEBHOOK_BODY_BYTES);
  if (raw === null) return reject(413, 'too_large', 'This request is too large.');
  if (!(await appPaypal().verifyWebhook(request.headers, raw))) return reject(400, 'unverified', NOT_VERIFIED);
  const event = parseEvent(raw);
  if (!event) return reject(400, 'malformed', 'The event has no id or event type.');

  await appDb().transaction(async (tx) => {
    const [fresh] = await tx
      .insert(webhookEvents)
      .values({ eventId: event.id, eventType: event.event_type, payload: event })
      .onConflictDoNothing({ target: webhookEvents.eventId })
      .returning({ id: webhookEvents.id });
    if (fresh) await enqueue(tx, 'webhook', { eventId: event.id });
  });
  return Response.json({ received: true });
}
