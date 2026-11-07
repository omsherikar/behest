import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sellerDeps } from '@/lib/app-deps';
import { Cart } from '@/lib/domain/cart';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { clientAddress, PUBLIC_READ_LIMIT, rateLimit } from '@/lib/ratelimit';
import { verifyForRoute } from '@/lib/sellers/intake';

// Checks a receipt against a cart and seller, open to anyone, and never records anything. `intake`
// (the default) answers as order intake would, freshness and replay included. `audit` is for
// receipts looked at long after they were used, such as on the dashboard's receipt card: it checks
// the signature, seller, cart and amount but not the receipt's age or replay.

const ROUTE = 'receipt_verify';

const NOT_JSON = 'Send the receipt check as JSON: { jws, cart, sellerSlug, mode? }.';

const VerifyRequest = z.object(
  {
    jws: z.string({ error: 'jws must be the receipt as a compact JWS.' }),
    cart: Cart,
    sellerSlug: z.string({ error: 'sellerSlug must name the seller.' }).min(1, { error: 'sellerSlug must name the seller.' }),
    mode: z.enum(['intake', 'audit'], { error: "mode must be 'intake' or 'audit'." }).default('intake'),
  },
  { error: NOT_JSON },
);

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** The first problem with a request body, naming where it is, such as `cart.totalCents: ...`. */
function problem(issues: z.ZodError['issues']): string {
  const [issue] = issues;
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

/**
 * `POST { jws, cart, sellerSlug, mode? }`: 200 with `{ ok: true, payload }` for a receipt that
 * passes, or `{ ok: false, reason }` naming the check it failed. A failed check is an answer, not an
 * error.
 */
export async function POST(request: NextRequest) {
  // Reads the database in intake mode, never at build time.
  await connection();

  if (!rateLimit(`${ROUTE}:${clientAddress(request)}`, PUBLIC_READ_LIMIT)) {
    return error(429, 'Too many requests at once. Try again in a minute.');
  }

  const raw = await readBody(request, FORM_BODY_BYTES);
  if (raw === null) return error(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return error(400, NOT_JSON);
  }
  const parsed = VerifyRequest.safeParse(body);
  if (!parsed.success) return error(400, problem(parsed.error.issues));

  return Response.json(await verifyForRoute(sellerDeps(), parsed.data));
}
