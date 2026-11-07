import { createHash, timingSafeEqual } from 'node:crypto';
import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb } from '@/lib/app-deps';
import { DemoBusy, resetDemo } from '@/lib/demo/seed';
import { readBody } from '@/lib/http/read-body';
import { personaRefusal } from '@/lib/session';

// Puts the demo back to its starting point before the next run: every purchase and what hangs off it,
// every mandate and queued job removed, and the demo sellers and buyer seeded again. Anyone can pick the
// operator persona, so the persona alone is not enough: the request must also carry the server's
// DEMO_RESET_KEY, and say so in the body, so neither a visitor nor a stray request can wipe the demo.

/** The header that carries the reset key. */
const KEY_HEADER = 'x-demo-reset-key';
/** The shortest DEMO_RESET_KEY that turns the reset on. */
const MIN_KEY_LENGTH = 16;

/** The largest body read. The only one accepted is `{"confirm":"reset"}`, with `"full":true` at most. */
const MAX_BODY_BYTES = 1024;

const CONFIRM = 'Send {"confirm":"reset"} to reset the demo, with "full":true to remove the linked wallet too.';
const FAILED = 'The demo could not be reset, and nothing was removed. Try again.';
const DISABLED = 'Resetting the demo is turned off on this server.';
const WRONG_KEY = `Send the demo reset key in the ${KEY_HEADER} header.`;
const BUSY = 'A payment is in progress. Reset the demo between runs, not during one.';

const ResetRequest = z.strictObject({ confirm: z.literal('reset'), full: z.boolean().optional() });

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** Whether `given` is `key`, compared in constant time: both are hashed first, so their lengths never differ. */
function isResetKey(given: string | null, key: string): boolean {
  const digest = (text: string) => createHash('sha256').update(text).digest();
  return given !== null && timingSafeEqual(digest(given), digest(key));
}

/**
 * `POST {"confirm":"reset", "full"?: boolean}` from the operator, with DEMO_RESET_KEY in the
 * `x-demo-reset-key` header: resets the demo and answers 200 with
 * `{ removed, seeded }`, how many rows of each kind it removed and what it seeded. A linked wallet is
 * kept, because linking again needs the buyer at PayPal, unless `full` is true. Answers 409, removing
 * nothing, while a payment is in progress. While DEMO_RESET_KEY is unset or shorter than 16 characters,
 * the reset is turned off and every request gets 403.
 */
export async function POST(request: NextRequest) {
  // Writes to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'operator');
  if (refusal) return refusal;
  const key = process.env.DEMO_RESET_KEY ?? '';
  if (key.length < MIN_KEY_LENGTH) return error(403, DISABLED);
  if (!isResetKey(request.headers.get(KEY_HEADER), key)) return error(403, WRONG_KEY);

  const raw = await readBody(request, MAX_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  const parsed = ResetRequest.safeParse(body);
  if (!parsed.success) return error(400, CONFIRM);

  try {
    const result = await resetDemo(appDb(), { payeeEmail: process.env.PAYEE_EMAIL ?? '', full: parsed.data.full });
    return Response.json(result);
  } catch (failure) {
    if (failure instanceof DemoBusy) return error(409, BUSY);
    // The reset runs in one transaction, so a failure leaves the demo as it was.
    console.error('[demo] Reset failed:', failure);
    return error(500, FAILED);
  }
}
