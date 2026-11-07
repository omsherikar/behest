import { and, eq, gt, gte, inArray, isNotNull, lt, ne, sum } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { mandates, products, purchases, sellers, wallets } from '@/lib/db/schema';
import { MandatePolicy } from '@/lib/domain/policy';
import type { CatalogEntry, GateInput } from '@/lib/gate/evaluate';
import { periodStart } from '@/lib/gate/period';
import { quoteAgentText } from '@/lib/gate/rules/check';
import { whatWouldChange, type IntentVerdict, type WhatWouldChange } from '@/lib/gate/what-would-change';
import { COUNTS_AGAINST_BUDGET } from '@/lib/purchases/transitions';

// "What would change" for a purchase already decided: the gate's input rebuilt as it was when the
// gate decided, and the answer the pages show. The replay counts the buyer's spend and recent
// purchases from before this one, excluding it, at the moment it was proposed. The mandate's state
// is today's: once a mandate has expired or been replaced, no change to it can allow anything.

const HOUR_MS = 60 * 60 * 1000;

/** What the pages show: the answer without the adjusted policies, which stay on the server. */
export type ChangeView =
  | { kind: 'allowed' }
  | { kind: 'changes'; approve: boolean; together: boolean; changes: { text: string; outcome: 'ALLOW' | 'ASK' }[] }
  | { kind: 'cannot'; reason: string };

export function changeView(answer: WhatWouldChange): ChangeView {
  if (answer.kind !== 'changes') return answer;
  const { approve, together, changes } = answer;
  return { kind: 'changes', approve, together, changes: changes.map(({ text, outcome }) => ({ text, outcome })) };
}

/**
 * The gate's input for the stored purchase as it was decided, and the intent check's verdict, or
 * null when the purchase or its mandate cannot be read back.
 */
export async function gateReplay(db: Db, purchaseId: string, now: Date): Promise<{ input: GateInput; intent: IntentVerdict } | null> {
  const [row] = await db
    .select({ purchase: purchases, mandate: mandates, sellerSlug: sellers.slug, sellerName: sellers.name })
    .from(purchases)
    .innerJoin(mandates, eq(mandates.id, purchases.mandateId))
    .leftJoin(sellers, eq(sellers.id, purchases.sellerId))
    .where(eq(purchases.id, purchaseId));
  if (!row) return null;
  const { purchase, mandate } = row;
  const policy = MandatePolicy.safeParse(mandate.policy);
  if (!policy.success) return null;

  const decidedAt = purchase.createdAt;
  const proposedSlug = typeof purchase.proposal?.sellerSlug === 'string' ? purchase.proposal.sellerSlug : '';
  const seller = row.sellerSlug && row.sellerName ? { slug: row.sellerSlug, name: row.sellerName } : { slug: proposedSlug, name: quoteAgentText(proposedSlug) };
  const skus = Array.isArray(purchase.proposal?.items)
    ? purchase.proposal.items.map((item) => item?.sku).filter((sku): sku is string => typeof sku === 'string')
    : [];
  const catalog = purchase.sellerId && skus.length > 0 ? await catalogOf(db, purchase.sellerId, skus) : new Map<string, CatalogEntry>();

  const before = and(
    eq(purchases.buyerId, purchase.buyerId),
    inArray(purchases.status, [...COUNTS_AGAINST_BUDGET]),
    ne(purchases.id, purchase.id),
    lt(purchases.createdAt, decidedAt),
  );
  const start = periodStart(policy.data.budget.period, decidedAt, mandate.confirmedAt);
  const [{ spent }] = await db.select({ spent: sum(purchases.totalCents) }).from(purchases).where(and(before, gte(purchases.createdAt, start)));
  const { velocity } = policy.data;
  const recent =
    velocity === null
      ? []
      : await db
          .select({ at: purchases.createdAt })
          .from(purchases)
          .where(and(before, gt(purchases.createdAt, new Date(decidedAt.getTime() - velocity.windowHours * HOUR_MS))));

  const [wallet] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.buyerId, purchase.buyerId), eq(wallets.status, 'linked'), isNotNull(wallets.paymentTokenId)));

  // Today's state of the mandate: a mandate past its expiry counts as expired however it is stored.
  const expiries = [mandate.expiresAt, policy.data.expiresAt === null ? null : new Date(policy.data.expiresAt)];
  const expired = expiries.some((at) => at !== null && at.getTime() <= now.getTime());
  const status = mandate.status === 'active' && expired ? 'expired' : mandate.status;

  return {
    input: {
      policy: policy.data,
      mandate: { status, expiresAt: mandate.expiresAt },
      walletLinked: wallet !== undefined,
      seller,
      proposal: purchase.proposal,
      catalog,
      spentInPeriodCents: Number(spent ?? 0),
      recentPurchaseTimes: recent.map((p) => p.at),
      now: decidedAt,
    },
    intent: purchase.intent?.verdict ?? null,
  };
}

async function catalogOf(db: Db, sellerId: string, skus: string[]): Promise<Map<string, CatalogEntry>> {
  const rows = await db
    .select({
      sku: products.sku,
      title: products.title,
      category: products.category,
      priceCents: products.priceCents,
      stock: products.stock,
      flags: products.flags,
      marketMedianCents: products.marketMedianCents,
    })
    .from(products)
    .where(and(eq(products.sellerId, sellerId), inArray(products.sku, skus)));
  return new Map(rows.map((row) => [row.sku, row]));
}

/** What would let the stored purchase through, for the pages, or null when it cannot be replayed. */
export async function changeFor(db: Db, purchaseId: string, now: Date): Promise<ChangeView | null> {
  const replay = await gateReplay(db, purchaseId, now);
  return replay && changeView(whatWouldChange(replay.input, replay.intent));
}
