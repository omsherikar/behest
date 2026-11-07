import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@/lib/db/client';
import { sellerOrders, sellers } from '@/lib/db/schema';
import { Cart } from '@/lib/domain/cart';
import { acceptAgentOrder, UnknownSellerError, verifyForRoute } from '@/lib/sellers/intake';
import { modulesReachedFrom, REPO_ROOT } from '@/tests/helpers/module-graph';
import { forgeReceipt, raviCart, RECEIPT_ISSUED, receiptFor, receiptJwks, signReceipt } from '@/tests/helpers/receipts';
import { createTestDb } from '@/tests/helpers/test-db';

// The first createTestDb() call in a file migrates a template database, which can take several
// seconds while other test files do the same. Do it before the tests so none is timed against it.
beforeAll(async () => {
  await createTestDb();
}, 60_000);

const cart = raviCart;
const sign = signReceipt;
const ISSUED = RECEIPT_ISSUED;
/** Five minutes after issue, inside the 15 minutes a receipt is fresh for. */
const NOW = new Date(ISSUED.getTime() + 5 * 60 * 1000);
const DAY_MS = 24 * 60 * 60 * 1000;

/** The cart with one more packet of cumin than the receipt was issued for. */
const changedCart = Cart.parse({ ...cart, items: [cart.items[0], { ...cart.items[1], quantity: 3 }], totalCents: 2025 });

/** The tables intake may touch. Purchases, their events and Behest's own receipts are not among them. */
const INTAKE_TABLES = ['seller_orders', 'sellers'];

/** The tables `statements` read or write, once each, sorted. */
function tablesIn(statements: string[]): string[] {
  const named = statements.flatMap((sql) => [...sql.matchAll(/\b(?:from|into|update|join)\s+"(\w+)"/g)].map((m) => m[1]));
  return [...new Set(named)].sort();
}

/** The statement logs of every database set up in the current test. */
const statementLogs: string[][] = [];

// Every intake call in this file, accepted, rejected, failed or only verified, is checked against the
// tables it may touch.
afterEach(() => {
  const logs = statementLogs.splice(0);
  for (const statements of logs) {
    expect(tablesIn(statements).filter((table) => !INTAKE_TABLES.includes(table))).toEqual([]);
    expect(statements.filter((sql) => /purchase|"receipts"/.test(sql))).toEqual([]);
  }
});

/**
 * Routes every statement the database's client runs through `intercept`, which may hold it, fail it
 * or pass it on with `run`. Returns a function that restores the client.
 */
function interceptQueries(db: Db, intercept: (sql: string, run: () => Promise<unknown>) => Promise<unknown>) {
  const client = (db as unknown as { $client: PGlite }).$client;
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  client.query = ((sql: string, ...rest: unknown[]) => intercept(sql, () => query(sql, ...rest))) as PGlite['query'];
  return () => {
    client.query = query as PGlite['query'];
  };
}

/** A database holding two sellers, every statement it runs from here on, and intake dependencies over it. */
async function setup(now = NOW) {
  const statements: string[] = [];
  statementLogs.push(statements);
  const db = await createTestDb({ logger: { logQuery: (query) => statements.push(query) } });
  await db.insert(sellers).values([
    { slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' },
    { slug: 'gadget-hub', name: 'Gadget Hub', payoutEmail: 'gadgets@example.com' },
  ]);
  statements.length = 0;
  return { db, statements, deps: { db, jwks: async () => receiptJwks, now: () => now } };
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
    const forged = await forgeReceipt(payload);

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
    let replayChecks = 0;
    let bothChecked!: () => void;
    const checked = new Promise<void>((resolve) => (bothChecked = resolve));
    interceptQueries(db, async (sql, run) => {
      if (/^insert into "seller_orders"/.test(sql)) await checked;
      const result = await run();
      if (/^select .* from "seller_orders"/.test(sql) && (replayChecks += 1) === 2) bothChecked();
      return result;
    });

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

  it('lets a failure reading earlier orders propagate, recording nothing', async () => {
    const { db, deps } = await setup();
    const failure = new Error('replay store unavailable');
    const restore = interceptQueries(db, async (sql, run) => {
      if (/^select .* from "seller_orders"/.test(sql)) throw failure;
      return run();
    });

    const attempt = acceptAgentOrder(deps, order(await sign(receiptFor(cart))));

    await expect(attempt).rejects.toMatchObject({ cause: failure });
    restore();
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

    expect(await audit(await forgeReceipt(payload))).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await audit(await sign(payload), cart, 'gadget-hub')).toEqual({ ok: false, reason: 'wrong_seller' });
    expect(await audit(await sign(payload), changedCart)).toEqual({ ok: false, reason: 'cart_mismatch' });
    const underpaid = { ...payload, payment: { ...payload.payment, amountCents: 1649 } };
    expect(await audit(await sign(underpaid))).toEqual({ ok: false, reason: 'amount_mismatch' });
    expect(await audit('not-a-jws')).toEqual({ ok: false, reason: 'malformed' });
    expect(statements).toEqual([]);
  });

  it('in audit mode still rejects a receipt claiming to be issued over a minute in the future', async () => {
    const { deps } = await setup();
    const issuedIn = async (ms: number) =>
      verifyForRoute(deps, {
        jws: await sign(receiptFor(cart, new Date(NOW.getTime() + ms))),
        cart,
        sellerSlug: 'ravi-spices',
        mode: 'audit',
      });

    expect(await issuedIn(2 * 60 * 1000)).toEqual({ ok: false, reason: 'expired' });
    expect(await issuedIn(60 * 1000 + 1000)).toEqual({ ok: false, reason: 'expired' });
    expect(await issuedIn(60 * 1000)).toMatchObject({ ok: true });
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

describe('the intake purchase boundary', () => {
  const INTAKE = join(REPO_ROOT, 'lib/sellers/intake.ts');

  it('touches only the sellers and seller_orders tables when it accepts, rejects and verifies', async () => {
    const { db, statements, deps } = await setup();
    const jws = await sign(receiptFor(cart));
    await acceptAgentOrder(deps, order(jws));
    await acceptAgentOrder(deps, order(jws));
    await acceptAgentOrder(deps, order('not-a-jws'));
    for (const mode of ['intake', 'audit'] as const) {
      await verifyForRoute(deps, { jws, cart, sellerSlug: 'ravi-spices', mode });
    }

    expect(tablesIn(statements)).toEqual(INTAKE_TABLES);
    expect(statements.filter((sql) => /purchase|"receipts"/.test(sql))).toEqual([]);
    expect(await db.select().from(sellerOrders)).toHaveLength(3);
  });

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
