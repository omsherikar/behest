import { asc, eq } from 'drizzle-orm';
import { demoBuyerId } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import {
  buyers,
  disputes,
  jobs,
  llmCalls,
  mandates,
  payouts,
  products,
  purchaseEvents,
  purchases,
  receipts,
  refunds,
  sellerOrders,
  sellers,
  wallets,
  webhookEvents,
  type WalletStatus,
} from '@/lib/db/schema';
import { DEMO_SELLER_SLUG } from '@/lib/demo/personas';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { seededCart } from '@/tests/helpers/seed-purchase';

// What one run of the demo leaves behind, on the seeded buyer and seller, for tests of the demo reset.

const HASH = 'a'.repeat(64);

/**
 * A demo run on the seeded buyer and seller: a wallet in `wallet`, a mandate, a purchase with an
 * event, a receipt, a seller order, a payout, a refund and a dispute, a queued job, a logged model
 * call and a processed webhook.
 */
export async function addDemoActivity(db: Db, { wallet = 'linked' }: { wallet?: WalletStatus } = {}): Promise<void> {
  const buyerId = await demoBuyerId(db);
  const [seller] = await db.select({ id: sellers.id }).from(sellers).where(eq(sellers.slug, DEMO_SELLER_SLUG));
  await db.insert(wallets).values({
    buyerId,
    status: wallet,
    paypalCustomerId: 'CUSTOMER-1',
    paymentTokenId: wallet === 'linked' ? 'TOKEN-1' : null,
    linkedAt: wallet === 'linked' ? new Date('2026-11-01T09:05:00Z') : null,
  });
  const [mandate] = await db
    .insert(mandates)
    .values({
      buyerId,
      sourceText: '$60 a month on groceries and spices',
      policy: demoPolicy,
      policyHash: HASH,
      readback: ['Up to $60.00 a month.'],
      readbackHash: HASH,
      jws: 'mandate.jws.value',
      confirmedAt: new Date('2026-11-01T09:00:00Z'),
    })
    .returning({ id: mandates.id });
  const [purchase] = await db
    .insert(purchases)
    .values({
      buyerId,
      mandateId: mandate.id,
      sellerId: seller.id,
      request: 'Restock turmeric and cumin',
      proposal: {
        sellerSlug: DEMO_SELLER_SLUG,
        items: seededCart.items.map(({ sku, quantity }) => ({ sku, quantity })),
        rationale: 'The buyer asked for turmeric and cumin.',
      },
      cart: seededCart,
      cartHash: HASH,
      totalCents: seededCart.totalCents,
      gateVerdict: 'ALLOW',
      rulesetVersion: 'gate-v1',
      finalVerdict: 'ALLOW',
      approver: 'policy',
      status: 'disputed',
      paypalCaptureId: 'CAPTURE-1',
    })
    .returning({ id: purchases.id });
  const purchaseId = purchase.id;
  await db.insert(purchaseEvents).values({ purchaseId, kind: 'gate', data: { verdict: 'ALLOW' } });
  const [receipt] = await db
    .insert(receipts)
    .values({ purchaseId, jws: 'receipt.jws.value', payloadHash: HASH, keyId: 'key-1' })
    .returning({ id: receipts.id });
  await db
    .insert(sellerOrders)
    .values({ sellerId: seller.id, receiptId: receipt.id, status: 'accepted', cart: seededCart, receiptJws: 'receipt.jws.value' });
  await db
    .insert(payouts)
    .values({ purchaseId, sellerId: seller.id, amountCents: seededCart.totalCents, senderBatchId: `${purchaseId}:payout` });
  await db.insert(refunds).values({ purchaseId, amountCents: seededCart.totalCents, reason: 'Not delivered' });
  await db.insert(disputes).values({
    paypalDisputeId: 'PP-D-1',
    purchaseId,
    captureId: 'CAPTURE-1',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'OPEN',
    amountCents: seededCart.totalCents,
  });
  await db.insert(jobs).values({ kind: 'payout', payload: { purchaseId } });
  await db.insert(llmCalls).values({ route: 'mandate_compile', model: 'claude-opus-5-5', effort: 'medium', ok: true, costUsd: 0.02 });
  await db.insert(webhookEvents).values({ eventId: 'WH-1', eventType: 'PAYMENT.CAPTURE.COMPLETED', payload: {} });
}

/** How many rows each table the demo touches holds. */
export async function rowCounts(db: Db): Promise<Record<string, number>> {
  const tables = {
    buyers,
    wallets,
    mandates,
    sellers,
    products,
    purchases,
    purchaseEvents,
    receipts,
    sellerOrders,
    payouts,
    refunds,
    disputes,
    webhookEvents,
    jobs,
    llmCalls,
  };
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(tables)) counts[name] = await db.$count(table);
  return counts;
}

/** The rows the seed writes and a reset keeps, in a fixed order, without the update times an upsert moves on. */
export async function seededRows(db: Db) {
  const unstamped = <T extends { updatedAt: Date }>(rows: T[]) => rows.map((row) => ({ ...row, updatedAt: undefined }));
  return {
    buyers: await db.select().from(buyers).orderBy(asc(buyers.id)),
    sellers: await db.select().from(sellers).orderBy(asc(sellers.slug)),
    products: unstamped(await db.select().from(products).orderBy(asc(products.sellerId), asc(products.sku))),
    wallets: unstamped(await db.select().from(wallets).orderBy(asc(wallets.id))),
  };
}
