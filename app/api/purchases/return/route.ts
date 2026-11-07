import { and, eq } from 'drizzle-orm';
import { connection, type NextRequest, NextResponse } from 'next/server';
import { appDb, appUrl, demoBuyerId, purchaseDeps } from '@/lib/app-deps';
import { purchases } from '@/lib/db/schema';
import { completeApproval } from '@/lib/purchases/approval';
import { describeFailure } from '@/lib/purchases/settle';
import { clientAddress, MODEL_ROUTE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { getPersona, SESSION_COOKIE } from '@/lib/session';

// Where PayPal sends the buyer back once they approve a purchase's order, with the order id as
// `token`. Anyone can open this URL with any query string, so the order is looked up among the
// session buyer's own purchases only, and nothing reaches PayPal for an order that is not theirs.
// The route then captures the order through completeApproval, which captures once however often it
// runs, and sends the buyer to their approvals page with how it went. The redirect carries only
// the purchase's own id or a fixed word, never PayPal's text or Behest's.

const ROUTE = 'purchase_return';
const FAILED = "[purchases] Completing an approval on the buyer's return failed:";

type Notice = { approved: string } | { pending: string } | { error: 'unknown' | 'failed' };

/** The buyer's approvals page, with the notice of how the return went, if any. */
function backToApprovals(notice?: Notice): NextResponse {
  const url = new URL('/buyer/approvals', appUrl());
  for (const [name, value] of Object.entries(notice ?? {})) url.searchParams.set(name, value);
  return NextResponse.redirect(url);
}

/**
 * `GET ?token=<order id>`: captures the order of the session buyer's purchase awaiting approval and
 * redirects to `/buyer/approvals` with `approved=<purchase id>`, also for a purchase already past
 * approval; with `pending=<purchase id>` when PayPal says the buyer has not approved the order yet;
 * or with `error=unknown` for an order that is not one of the buyer's purchases, and `error=failed`
 * when completing it threw or the client is over its rate limit. A visitor without the buyer
 * persona goes to the page with no notice, and nothing is completed.
 */
export async function GET(request: NextRequest) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const persona = await getPersona(request.cookies.get(SESSION_COOKIE)?.value);
  if (persona !== 'buyer') return backToApprovals();
  // Capturing moves money, so returns are limited like the routes that call a model.
  if (!rateLimit(`${ROUTE}:${clientAddress(request)}:buyer`, MODEL_ROUTE_LIMIT)) return backToApprovals({ error: 'failed' });

  const orderId = request.nextUrl.searchParams.get('token');
  try {
    const db = appDb();
    const buyerId = await demoBuyerId(db);
    const [purchase] = orderId
      ? await db
          .select({ id: purchases.id })
          .from(purchases)
          .where(and(eq(purchases.buyerId, buyerId), eq(purchases.paypalOrderId, orderId)))
      : [];
    if (!orderId || !purchase) return backToApprovals({ error: 'unknown' });

    const outcome = await completeApproval(await purchaseDeps(), orderId);
    // Sent back for approval: PayPal would not capture an order the buyer has not approved.
    if (outcome.status === 'awaiting_approval') return backToApprovals({ pending: purchase.id });
    return backToApprovals({ approved: purchase.id });
  } catch (failure) {
    console.error(FAILED, describeFailure(failure));
    return backToApprovals({ error: 'failed' });
  }
}
