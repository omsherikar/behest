import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { appDb } from '@/lib/app-deps';
import { resetDemo } from '@/lib/demo/seed';
import { readBody } from '@/lib/http/read-body';
import { personaRefusal } from '@/lib/session';

// Puts the demo back to its starting point before the next run: every purchase and what hangs off it,
// every mandate and queued job removed, and the demo sellers and buyer seeded again. Only the operator
// may, and only by saying so in the body, so a stray request cannot wipe the demo.

/** The largest body read. The only one accepted is `{"confirm":"reset"}`, with `"full":true` at most. */
const MAX_BODY_BYTES = 1024;

const CONFIRM = 'Send {"confirm":"reset"} to reset the demo, with "full":true to remove the linked wallet too.';
const FAILED = 'The demo could not be reset, and nothing was removed. Try again.';

const ResetRequest = z.strictObject({ confirm: z.literal('reset'), full: z.boolean().optional() });

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/**
 * `POST {"confirm":"reset", "full"?: boolean}`: resets the demo and answers 200 with
 * `{ removed, seeded }`, how many rows of each kind it removed and what it seeded. A linked wallet is
 * kept, because linking again needs the buyer at PayPal, unless `full` is true.
 */
export async function POST(request: NextRequest) {
  // Writes to the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'operator');
  if (refusal) return refusal;

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
    // The reset runs in one transaction, so a failure leaves the demo as it was.
    console.error('[demo] Reset failed:', failure);
    return error(500, FAILED);
  }
}
