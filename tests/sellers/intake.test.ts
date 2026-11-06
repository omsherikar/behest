import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import { Cart } from '@/lib/domain/cart';
import type { ReceiptPayload } from '@/lib/domain/receipt';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { acceptAgentOrder, UnknownSellerError, verifyForRoute } from '@/lib/sellers/intake';
import { modulesReachedFrom, REPO_ROOT } from '@/tests/helpers/module-graph';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const JWKS = publicJwks([key]);
const foreignSigner = createSigner(await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem }));

const ISSUED = new Date('2026-11-06T10:00:00Z');
/** Five minutes after issue, inside the 15 minutes a receipt is fresh for. */
const NOW = new Date('2026-11-06T10:05:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// Two lines, three units: 900 + 2 * 375 = 1650 cents.
const cart = Cart.parse({
  seller: { slug: 'ravi-spices', name: "Ravi's Spice Co." },
  currency: 'USD',
  items: [
    { sku: 'SAF-1G', title: 'Kashmiri Saffron, 1 g', category: 'spices', unitPriceCents: 900, quantity: 1 },
    { sku: 'CUM-100', title: 'Whole Cumin Seeds, 100 g', category: 'spices', unitPriceCents: 375, quantity: 2 },
  ],
  totalCents: 1650,
});

/** The cart with one more packet of cumin than the receipt was issued for. */
const changedCart = Cart.parse({ ...cart, items: [cart.items[0], { ...cart.items[1], quantity: 3 }], totalCents: 2025 });

function receiptFor(c: Cart, issued = ISSUED): ReceiptPayload {
  return {
    v: 1,
    id: crypto.randomUUID(),
    iss: 'behest',
    iat: issued.getTime() / 1000,
    mandate: {
      id: crypto.randomUUID(),
      policyHash: hashOf({ categories: ['spices'], maxCents: 6000 }),
      jwsHash: sha256Hex('header.payload.signature'),
    },
    seller: { slug: c.seller.slug },
    cart: { hash: hashOf(c), totalCents: c.totalCents, currency: 'USD', itemCount: 3 },
    decision: {
      purchaseId: crypto.randomUUID(),
      verdict: 'ALLOW',
      approver: 'policy',
      rulesetVersion: 'gate-v1',
      outcomes: [{ rule: 'mandate_active', result: 'pass' }],
    },
    payment: {
      processor: 'paypal',
      orderId: 'ORDER-1',
      captureId: 'CAPTURE-1',
      amountCents: c.totalCents,
      capturedAt: ISSUED.toISOString(),
    },
  };
}

const sign = (payload: object) => signer.sign(payload, 'behest-receipt+jws');

/** A database holding two sellers, every statement it runs from here on, and intake dependencies over it. */
async function setup(now = NOW) {
  const statements: string[] = [];
  const db = await createTestDb({ logger: { logQuery: (query) => statements.push(query) } });
  await db.insert(sellers).values([
    { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
    { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
  ]);
  statements.length = 0;
  return { db, statements, deps: { db, jwks: async () => JWKS, now: () => now } };
}

/** Every seller order, as the seller slug it was presented to and what was recorded, accepted first. */
async function ordersOf(db: Db) {
  const rows = await db
    .select({
      seller: sellers.slug,
      receiptId: sellerOrders.receiptId,
      status: sellerOrders.status,
      reason: sellerOrders.reason,
      cart: sellerOrders.cart,
      receiptJws: sellerOrders.receiptJws,
    })
    .from(sellerOrders)
    .innerJoin(sellers, eq(sellers.id, sellerOrders.sellerId));
  return rows.sort((a, b) => a.status.localeCompare(b.status) || String(a.reason).localeCompare(String(b.reason)));
}

const order = (receiptJws: string, c: Cart = cart, sellerSlug = 'ravi-spices') => ({ sellerSlug, cart: c, receiptJws });

describe('acceptAgentOrder', () => {
  it('accepts a valid receipt once and rejects it again as replayed, recording both attempts', async () => {
    const { db, deps } = await setup();
    const payload = receiptFor(cart);
    const jws = await sign(payload);

    expect(await acceptAgentOrder(deps, order(jws))).toEqual({ status: 'accepted' });
    expect(await acceptAgentOrder(deps, order(jws))).toEqual({ status: 'rejected', reason: 'replayed' });

    expect(await ordersOf(db)).toEqual([
      { seller: 'ravi-spices', receiptId: payload.id, status: 'accepted', reason: null, cart, receiptJws: jws },
      { seller: 'ravi-spices', receiptId: payload.id, status: 'rejected', reason: 'replayed', cart, receiptJws: jws },
    ]);
  });

  it('records a rejected receipt with its reason and the id it carries, and still accepts the genuine order after it', async () => {
    const { db, deps } = await setup();
    const payload = receiptFor(cart);
    const jws = await sign(payload);

    expect(await acceptAgentOrder(deps, order(jws, changedCart))).toEqual({ status: 'rejected', reason: 'cart_mismatch' });
    expect(await acceptAgentOrder(deps, order(jws))).toEqual({ status: 'accepted' });

    expect(await ordersOf(db)).toEqual([
      expect.objectContaining({ receiptId: payload.id, status: 'accepted', reason: null, cart }),
      expect.objectContaining({ receiptId: payload.id, status: 'rejected', reason: 'cart_mismatch', cart: changedCart }),
    ]);
  });

  it('records a forged receipt as bad_signature under the id it claims, which does not block the genuine one', async () => {
    const { db, deps } = await setup();
    const payload = receiptFor(cart);
    const forged = await foreignSigner.sign(payload, 'behest-receipt+jws');

    expect(await acceptAgentOrder(deps, order(forged))).toEqual({ status: 'rejected', reason: 'bad_signature' });
    expect(await acceptAgentOrder(deps, order(await sign(payload)))).toEqual({ status: 'accepted' });
    expect((await ordersOf(db)).map((row) => [row.receiptId, row.status, row.reason])).toEqual([
      [payload.id, 'accepted', null],
      [payload.id, 'rejected', 'bad_signature'],
    ]);
  });

  it('records a receipt it cannot read an id from as malformed with no receipt id', async () => {
    const { db, deps } = await setup();
    const notAReceipt = await sign({ ...receiptFor(cart), id: 'order-7' });

    for (const jws of ['not-a-jws', 'a.b.c', notAReceipt]) {
      expect(await acceptAgentOrder(deps, order(jws))).toEqual({ status: 'rejected', reason: 'malformed' });
    }
    expect((await ordersOf(db)).map((row) => [row.receiptId, row.reason, row.receiptJws])).toEqual([
      [null, 'malformed', 'not-a-jws'],
      [null, 'malformed', 'a.b.c'],
      [null, 'malformed', notAReceipt],
    ]);
  });

  it('rejects a receipt presented 16 minutes after issue as expired', async () => {
    const { db, deps } = await setup(new Date(ISSUED.getTime() + 16 * 60 * 1000));
    expect(await acceptAgentOrder(deps, order(await sign(receiptFor(cart))))).toEqual({
      status: 'rejected',
      reason: 'expired',
    });
    expect(await ordersOf(db)).toEqual([expect.objectContaining({ status: 'rejected', reason: 'expired' })]);
  });

  it('records a receipt presented to another seller as wrong_seller under the seller it was presented to', async () => {
    const { db, deps } = await setup();
    expect(await acceptAgentOrder(deps, order(await sign(receiptFor(cart)), cart, 'gadget-hub'))).toEqual({
      status: 'rejected',
      reason: 'wrong_seller',
    });
    expect(await ordersOf(db)).toEqual([expect.objectContaining({ seller: 'gadget-hub', reason: 'wrong_seller' })]);
  });

  it('of two concurrent accepts of one receipt, accepts one and records the other as replayed, without throwing', async () => {
    const { db, deps } = await setup();
    const payload = receiptFor(cart);
    const jws = await sign(payload);
    // Hold every write to seller_orders until both attempts have looked for an accepted order, so
    // both pass the replay check and only the unique index on accepted orders can stop the second.
    const client = (db as unknown as { $client: PGlite }).$client;
    const query = client.query.bind(client);
    let replayChecks = 0;
    let bothChecked!: () => void;
    const checked = new Promise<void>((resolve) => (bothChecked = resolve));
    client.query = (async (sql: string, ...rest: unknown[]) => {
      if (/^insert into "seller_orders"/.test(sql)) await checked;
      const result = await (query as (...args: unknown[]) => Promise<unknown>)(sql, ...rest);
      if (/^select .* from "seller_orders"/.test(sql) && (replayChecks += 1) === 2) bothChecked();
      return result;
    }) as PGlite['query'];

    const results = await Promise.all([acceptAgentOrder(deps, order(jws)), acceptAgentOrder(deps, order(jws))]);

    expect(replayChecks).toBe(2);
    expect(results).toEqual(expect.arrayContaining([{ status: 'accepted' }, { status: 'rejected', reason: 'replayed' }]));
    expect((await ordersOf(db)).map((row) => [row.receiptId, row.status, row.reason])).toEqual([
      [payload.id, 'accepted', null],
      [payload.id, 'rejected', 'replayed'],
    ]);
  });

  it('throws for a seller slug it does not know, writing nothing', async () => {
    const { db, deps } = await setup();
    await expect(acceptAgentOrder(deps, order(await sign(receiptFor(cart)), cart, 'nobody'))).rejects.toBeInstanceOf(
      UnknownSellerError,
    );
    expect(await ordersOf(db)).toEqual([]);
  });

  it('lets a public key set that cannot be loaded propagate, writing nothing', async () => {
    const { db, deps } = await setup();
    const failure = new Error('key set unavailable');
    await expect(
      acceptAgentOrder({ ...deps, jwks: () => Promise.reject(failure) }, order(await sign(receiptFor(cart)))),
    ).rejects.toBe(failure);
    expect(await ordersOf(db)).toEqual([]);
  });
});

describe('verifyForRoute', () => {
  it('in audit mode accepts a receipt issued two days ago without running a database statement', async () => {
    const { statements, deps } = await setup();
    const payload = receiptFor(cart, new Date(NOW.getTime() - 2 * DAY_MS));

    expect(await verifyForRoute(deps, { jws: await sign(payload), cart, sellerSlug: 'ravi-spices', mode: 'audit' })).toEqual({
      ok: true,
      payload,
    });
    expect(statements).toEqual([]);
  });

  it('in audit mode still checks the signature, seller, cart and amount', async () => {
    const { statements, deps } = await setup();
    const payload = receiptFor(cart, new Date(NOW.getTime() - 2 * DAY_MS));
    const audit = async (jws: string, c = cart, sellerSlug = 'ravi-spices') =>
      verifyForRoute(deps, { jws, cart: c, sellerSlug, mode: 'audit' });

    expect(await audit(await foreignSigner.sign(payload, 'behest-receipt+jws'))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await audit(await sign(payload), cart, 'gadget-hub')).toEqual({ ok: false, reason: 'wrong_seller' });
    expect(await audit(await sign(payload), changedCart)).toEqual({ ok: false, reason: 'cart_mismatch' });
    const underpaid = { ...payload, payment: { ...payload.payment, amountCents: 1649 } };
    expect(await audit(await sign(underpaid))).toEqual({ ok: false, reason: 'amount_mismatch' });
    expect(await audit('not-a-jws')).toEqual({ ok: false, reason: 'malformed' });
    expect(statements).toEqual([]);
  });

  it('in audit mode verifies a receipt whose order was already accepted', async () => {
    const { deps } = await setup();
    const payload = receiptFor(cart);
    const jws = await sign(payload);
    await acceptAgentOrder(deps, order(jws));

    expect(await verifyForRoute(deps, { jws, cart, sellerSlug: 'ravi-spices', mode: 'audit' })).toEqual({ ok: true, payload });
  });

  it('in intake mode rejects a receipt older than the freshness window as expired', async () => {
    const { statements, deps } = await setup();
    const jws = await sign(receiptFor(cart, new Date(NOW.getTime() - 2 * DAY_MS)));

    expect(await verifyForRoute(deps, { jws, cart, sellerSlug: 'ravi-spices', mode: 'intake' })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(statements).toEqual([]);
  });

  it('in intake mode gives replayed for a receipt already accepted, and writes nothing', async () => {
    const { db, statements, deps } = await setup();
    const jws = await sign(receiptFor(cart));
    await acceptAgentOrder(deps, order(jws));
    const before = await ordersOf(db);
    statements.length = 0;

    expect(await verifyForRoute(deps, { jws, cart, sellerSlug: 'ravi-spices', mode: 'intake' })).toEqual({
      ok: false,
      reason: 'replayed',
    });
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => !sql.startsWith('select '))).toEqual([]);
    expect(await ordersOf(db)).toEqual(before);
  });

  it('in intake mode accepts a fresh receipt without writing, so its order can still be accepted', async () => {
    const { db, statements, deps } = await setup();
    const payload = receiptFor(cart);
    const jws = await sign(payload);

    expect(await verifyForRoute(deps, { jws, cart, sellerSlug: 'ravi-spices', mode: 'intake' })).toEqual({ ok: true, payload });
    expect(statements.filter((sql) => !sql.startsWith('select '))).toEqual([]);
    expect(await ordersOf(db)).toEqual([]);
    expect(await acceptAgentOrder(deps, order(jws))).toEqual({ status: 'accepted' });
  });

  it('in intake mode finds no replay for a seller Behest does not host', async () => {
    const { deps } = await setup();
    const outsideCart = Cart.parse({ ...cart, seller: { slug: 'outside-shop', name: 'Outside Shop' } });
    const payload = receiptFor(outsideCart);

    expect(
      await verifyForRoute(deps, { jws: await sign(payload), cart: outsideCart, sellerSlug: 'outside-shop', mode: 'intake' }),
    ).toEqual({ ok: true, payload });
  });
});

describe('the intake import boundary', () => {
  const INTAKE = join(REPO_ROOT, 'lib/sellers/intake.ts');

  it('reaches no purchase module through its imports', () => {
    const reached = [...modulesReachedFrom(INTAKE)];
    expect(reached).toContain('lib/receipts/verify-receipt.ts');
    expect(reached.filter((path) => path.startsWith('lib/purchases/'))).toEqual([]);
  });

  it('names only the sellers and seller_orders tables, and no purchase table in its code', () => {
    const source = readFileSync(INTAKE, 'utf8');
    const schemaImports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@\/lib\/db\/schema['"]/g)];
    const names = schemaImports.flatMap(([, list]) => list.split(',').map((name) => name.trim()).filter(Boolean));
    expect(names.sort()).toEqual(['sellerOrders', 'sellers']);
    expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+['"]@\/lib\/db\/schema['"]/);
    // Comments may explain what intake leaves alone; the code itself never names a purchase.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/purchase/i);
  });
});
