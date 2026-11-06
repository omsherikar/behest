import { and, eq, sql } from 'drizzle-orm';
import { decodeJwt, type JWK } from 'jose';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import type { Cart } from '@/lib/domain/cart';
import { ReceiptPayload } from '@/lib/domain/receipt';
import { type ReceiptRejection, verifyReceipt } from '@/lib/receipts/verify-receipt';

// Seller order intake: how a seller hosted on Behest takes an agent order. It works as an outside
// seller would, from the public key set, the receipt and the cart it received, and keeps its own
// record of orders in seller_orders. It reads no purchase table, so Behest's side of a purchase
// can never vouch for a receipt that does not verify on its own.

export type IntakeDeps = { db: Db; jwks: () => Promise<{ keys: JWK[] }>; now: () => Date };

export type OrderAnswer = { status: 'accepted' } | { status: 'rejected'; reason: ReceiptRejection };

/** An order was presented to a seller slug Behest does not host. Nothing is recorded. */
export class UnknownSellerError extends Error {
  constructor(readonly sellerSlug: string) {
    super('no seller has this slug');
    this.name = 'UnknownSellerError';
  }
}

const PresentedId = z.object({ id: ReceiptPayload.shape.id });

/**
 * Accepts an agent order when its receipt verifies for this seller and cart, and has not been
 * accepted before. Every attempt is recorded in seller_orders, accepted or rejected with its
 * reason. Of two concurrent accepts of one receipt, the unique index on accepted orders lets one
 * through and the other is recorded as `replayed`. Throws UnknownSellerError for a slug Behest does
 * not host; an error loading the key set or reading seller_orders propagates, recording nothing.
 */
export async function acceptAgentOrder(
  deps: IntakeDeps,
  i: { sellerSlug: string; cart: Cart; receiptJws: string },
): Promise<OrderAnswer> {
  const { db } = deps;
  const seller = await sellerBySlug(db, i.sellerSlug);
  if (!seller) throw new UnknownSellerError(i.sellerSlug);

  const result = await verifyReceipt({
    jws: i.receiptJws,
    cart: i.cart,
    sellerSlug: i.sellerSlug,
    jwks: await deps.jwks(),
    now: deps.now(),
    seen: (receiptId) => acceptedBefore(db, seller.id, receiptId),
  });
  const attempt = { sellerId: seller.id, cart: i.cart, receiptJws: i.receiptJws };

  if (!result.ok) {
    await db
      .insert(sellerOrders)
      .values({ ...attempt, receiptId: presentedReceiptId(i.receiptJws), status: 'rejected', reason: result.reason });
    return { status: 'rejected', reason: result.reason };
  }

  const receiptId = result.payload.id;
  const [accepted] = await db
    .insert(sellerOrders)
    .values({ ...attempt, receiptId, status: 'accepted' })
    .onConflictDoNothing({
      target: [sellerOrders.receiptId, sellerOrders.sellerId],
      where: sql`${sellerOrders.status} = 'accepted'`,
    })
    .returning({ id: sellerOrders.id });
  if (accepted) return { status: 'accepted' };

  // Another accept of this receipt passed the replay check at the same time and was recorded first.
  await db.insert(sellerOrders).values({ ...attempt, receiptId, status: 'rejected', reason: 'replayed' });
  return { status: 'rejected', reason: 'replayed' };
}

/**
 * Verifies a receipt for the verify route, writing nothing. `intake` runs every check an order
 * would, reading seller_orders for replay; a seller Behest does not host has no orders there, so
 * its receipts are never replays. `audit` checks the signature, seller, cart and amount only, for
 * receipts shown long after they were issued and presented, and reads nothing.
 */
export async function verifyForRoute(
  deps: IntakeDeps,
  i: { jws: string; cart: Cart; sellerSlug: string; mode: 'intake' | 'audit' },
): Promise<{ ok: true; payload: ReceiptPayload } | { ok: false; reason: ReceiptRejection }> {
  const audit = i.mode === 'audit';
  return verifyReceipt({
    jws: i.jws,
    cart: i.cart,
    sellerSlug: i.sellerSlug,
    jwks: await deps.jwks(),
    // An audit checks the receipt as of the time it claims to be issued, so its age never fails it.
    // Only an authentic receipt gets past the signature check, so the claim is the signed one.
    now: audit ? (claimedIssueTime(i.jws) ?? deps.now()) : deps.now(),
    seen: audit
      ? async () => false
      : async (receiptId) => {
          const seller = await sellerBySlug(deps.db, i.sellerSlug);
          return seller !== undefined && acceptedBefore(deps.db, seller.id, receiptId);
        },
  });
}

async function sellerBySlug(db: Db, slug: string): Promise<{ id: string } | undefined> {
  const [seller] = await db.select({ id: sellers.id }).from(sellers).where(eq(sellers.slug, slug)).limit(1);
  return seller;
}

async function acceptedBefore(db: Db, sellerId: string, receiptId: string): Promise<boolean> {
  const [order] = await db
    .select({ id: sellerOrders.id })
    .from(sellerOrders)
    .where(
      and(eq(sellerOrders.sellerId, sellerId), eq(sellerOrders.receiptId, receiptId), eq(sellerOrders.status, 'accepted')),
    )
    .limit(1);
  return order !== undefined;
}

/** The payload of a compact JWS, read without checking the signature, or null if it has none. */
function unverifiedPayload(jws: string): Record<string, unknown> | null {
  try {
    return decodeJwt(jws);
  } catch {
    return null;
  }
}

/** The receipt id a presented receipt carries, signed or not, or null when it has none in the receipt id format. */
function presentedReceiptId(jws: string): string | null {
  const parsed = PresentedId.safeParse(unverifiedPayload(jws));
  return parsed.success ? parsed.data.id : null;
}

/** The issue time a receipt claims, signed or not, or null when it claims none. */
function claimedIssueTime(jws: string): Date | null {
  const iat = unverifiedPayload(jws)?.iat;
  return typeof iat === 'number' ? new Date(iat * 1000) : null;
}
