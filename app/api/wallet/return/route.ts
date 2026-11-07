import { and, eq } from 'drizzle-orm';
import { connection, type NextRequest, NextResponse } from 'next/server';
import { appDb, appPaypal, appUrl, demoBuyerId } from '@/lib/app-deps';
import { wallets } from '@/lib/db/schema';
import { personaRefusal } from '@/lib/session';

// Where PayPal sends the buyer back once they approve saving their wallet. Anyone can open this URL
// with any query string, so the query is never read: the route exchanges only the setup token kept
// on the pending wallet of the session's buyer, then sends the buyer to their page with the outcome.

/** The buyer's page, with a notice of how linking went. */
const backToBuyer = (outcome: 'linked' | 'error') => NextResponse.redirect(`${appUrl()}/buyer?wallet=${outcome}`);

/** `GET`: links the session buyer's pending wallet and redirects to `/buyer?wallet=linked`, or `error`. */
export async function GET(request: NextRequest) {
  // Reads and writes the database on every request, never at build time.
  await connection();

  const refusal = await personaRefusal(request, 'buyer');
  if (refusal) return refusal;

  const db = appDb();
  const buyerId = await demoBuyerId(db);
  const [wallet] = await db.select().from(wallets).where(eq(wallets.buyerId, buyerId));
  if (!wallet || wallet.status !== 'pending' || !wallet.setupTokenId) return backToBuyer('error');
  const { setupTokenId } = wallet;

  let paymentToken: { id: string; customerId: string };
  try {
    paymentToken = await appPaypal().createPaymentToken(setupTokenId);
  } catch (failure) {
    console.error('[wallet] PayPal could not save the wallet:', failure);
    return backToBuyer('error');
  }

  // Linked only while the wallet still waits on this setup token: a confirm that started a new link
  // in the meantime replaced it, and its own approval links the wallet.
  const linked = await db
    .update(wallets)
    .set({ status: 'linked', paymentTokenId: paymentToken.id, paypalCustomerId: paymentToken.customerId, linkedAt: new Date() })
    .where(and(eq(wallets.id, wallet.id), eq(wallets.status, 'pending'), eq(wallets.setupTokenId, setupTokenId)))
    .returning({ id: wallets.id });
  return backToBuyer(linked.length > 0 ? 'linked' : 'error');
}
