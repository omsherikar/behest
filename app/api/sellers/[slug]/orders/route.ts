import { connection, type NextRequest } from 'next/server';
import { z } from 'zod';
import { sellerDeps } from '@/lib/app-deps';
import { Cart } from '@/lib/domain/cart';
import { FORM_BODY_BYTES, readBody } from '@/lib/http/read-body';
import { clientAddress, PUBLIC_WRITE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { acceptAgentOrder, UnknownSellerError } from '@/lib/sellers/intake';

// Where an agent places an order with a seller Behest hosts, open to any agent. The seller takes it
// only with a Behest receipt that verifies for this seller and this exact cart and has not been used
// before, and records every attempt, accepted or not.

const ROUTE = 'seller_orders';

const NOT_JSON = 'Send the order as JSON: { cart, receiptJws }.';

const OrderRequest = z.object(
  { cart: Cart, receiptJws: z.string({ error: 'receiptJws must be the receipt as a compact JWS.' }) },
  { error: NOT_JSON },
);

const error = (status: number, message: string) => Response.json({ error: { message } }, { status });

/** The first problem with an order body, naming where it is, such as `cart.totalCents: ...`. */
function problem(issues: z.ZodError['issues']): string {
  const [issue] = issues;
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

/**
 * `POST { cart, receiptJws }`: 201 `{ status: 'accepted' }` when the seller takes the order, or 422
 * `{ status: 'rejected', reason }` with the receipt check that failed, such as `replayed`.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/sellers/[slug]/orders'>) {
  // Writes to the database on every request, never at build time.
  await connection();

  if (!rateLimit(`${ROUTE}:${clientAddress(request)}`, PUBLIC_WRITE_LIMIT)) {
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
  const parsed = OrderRequest.safeParse(body);
  if (!parsed.success) return error(400, problem(parsed.error.issues));

  const { slug } = await ctx.params;
  try {
    const answer = await acceptAgentOrder(sellerDeps(), { sellerSlug: slug, ...parsed.data });
    return Response.json(answer, { status: answer.status === 'accepted' ? 201 : 422 });
  } catch (failure) {
    if (failure instanceof UnknownSellerError) return error(404, 'There is no seller at this address.');
    throw failure;
  }
}
