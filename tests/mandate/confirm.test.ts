import type { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { decodeProtectedHeader } from 'jose';
import { expect, it } from 'vitest';
import { z } from 'zod';
import type { Db } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';
import { buyers, mandates } from '@/lib/db/schema';
import type { MandatePolicy } from '@/lib/domain/policy';
import { MandatePayload } from '@/lib/domain/receipt';
import { confirmMandate } from '@/lib/mandate/confirm';
import { renderReadback } from '@/lib/mandate/readback';
import { hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner, verifyJws } from '@/lib/receipts/sign';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { createTestDb } from '@/tests/helpers/test-db';

const key = await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem });
const signer = createSigner(key);
const jwks = publicJwks([key]);

const NOW = new Date('2026-11-06T10:00:00.000Z');
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';

async function addBuyer(db: Db): Promise<string> {
  const [buyer] = await db.insert(buyers).values({ name: 'Priya' }).returning();
  return buyer.id;
}

/** A fresh database holding one buyer, and the deps confirmMandate takes. */
async function setup() {
  const db = await createTestDb();
  const buyerId = await addBuyer(db);
  return { db, buyerId, deps: { db, signer, now: () => NOW } };
}

const allMandates = (db: Db) => db.select().from(mandates);

it('stores an active mandate holding the buyer text, the policy, its hashes and the signed JWS', async () => {
  const { db, buyerId, deps } = await setup();

  const { mandateId, jws } = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  const rows = await allMandates(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: mandateId,
    buyerId,
    sourceText: TEXT,
    policy: demoPolicy,
    policyHash: hashOf(demoPolicy),
    readback: renderReadback(demoPolicy),
    readbackHash: hashOf(renderReadback(demoPolicy)),
    jws,
    status: 'active',
    confirmedAt: NOW,
    expiresAt: null,
  });
});

it('hashes exactly the readback lines it stores', async () => {
  const { db, buyerId, deps } = await setup();

  await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  const [row] = await allMandates(db);
  expect(row.readbackHash).toBe(hashOf(row.readback));
});

it('signs a mandate JWS that verifies against the public keys and carries the policy hash', async () => {
  const { buyerId, deps } = await setup();

  const { jws } = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  const payload = await verifyJws(jws, 'behest-mandate+jws', jwks, MandatePayload);
  expect(payload.policyHash).toBe(hashOf(demoPolicy));
  expect(decodeProtectedHeader(jws)).toEqual({ alg: 'EdDSA', kid: key.kid, typ: 'behest-mandate+jws' });
});

it('signs a mandate payload that names the buyer only by the hash of their id', async () => {
  const { db, buyerId, deps } = await setup();

  const { mandateId, jws } = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  const payload = await verifyJws(jws, 'behest-mandate+jws', jwks, MandatePayload);
  const [row] = await allMandates(db);
  expect(payload).toEqual({
    v: 1,
    id: mandateId,
    iss: 'behest',
    iat: NOW.getTime() / 1000,
    buyer: { ref: sha256Hex(buyerId) },
    policyHash: row.policyHash,
    readbackHash: row.readbackHash,
    confirmedAt: NOW.toISOString(),
    confirmation: 'session',
    expiresAt: null,
  });
  expect(row.id).toBe(mandateId);
});

it('stores the policy expiry as the mandate expiry and signs the same instant', async () => {
  const { db, buyerId, deps } = await setup();
  const policy: MandatePolicy = { ...demoPolicy, expiresAt: '2026-12-31T23:59:59.999Z' };

  const { jws } = await confirmMandate(deps, { buyerId, text: TEXT, policy });

  const [row] = await allMandates(db);
  expect(row.expiresAt).toEqual(new Date('2026-12-31T23:59:59.999Z'));
  const payload = await verifyJws(jws, 'behest-mandate+jws', jwks, MandatePayload);
  expect(payload.expiresAt).toBe('2026-12-31T23:59:59.999Z');
});

it('revokes the buyer\'s active mandate when they confirm a new one', async () => {
  const { db, buyerId, deps } = await setup();

  const first = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });
  const second = await confirmMandate(deps, {
    buyerId,
    text: '$100 a month on groceries',
    policy: { ...demoPolicy, budget: { amountCents: 10000, period: 'month' } },
  });

  const statusOf = async (id: string) =>
    (await db.select({ status: mandates.status }).from(mandates).where(eq(mandates.id, id)))[0].status;
  expect(await statusOf(first.mandateId)).toBe('revoked');
  expect(await statusOf(second.mandateId)).toBe('active');
});

it('leaves other buyers\' active mandates alone', async () => {
  const { db, buyerId, deps } = await setup();
  const otherBuyerId = await addBuyer(db);
  const other = await confirmMandate(deps, { buyerId: otherBuyerId, text: TEXT, policy: demoPolicy });

  await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  const [row] = await db.select().from(mandates).where(eq(mandates.id, other.mandateId));
  expect(row.status).toBe('active');
});

it.each<{ name: string; policy: MandatePolicy }>([
  { name: 'a per-purchase limit above the budget', policy: { ...demoPolicy, perPurchaseMaxCents: 7000 } },
  { name: 'a field the policy does not define', policy: { ...demoPolicy, note: 'extra' } as MandatePolicy },
])('throws for a policy with $name and changes nothing', async ({ policy }) => {
  const { db, buyerId, deps } = await setup();
  const existing = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  await expect(confirmMandate(deps, { buyerId, text: TEXT, policy })).rejects.toThrow(z.ZodError);

  const rows = await allMandates(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: existing.mandateId, status: 'active' });
});

it.each([
  { name: 'has already passed', expiresAt: '2026-11-06T09:00:00.000Z' },
  { name: 'is the confirmation time itself', expiresAt: NOW.toISOString() },
])('throws when the policy expiry $name and changes nothing', async ({ expiresAt }) => {
  const { db, buyerId, deps } = await setup();
  const existing = await confirmMandate(deps, { buyerId, text: TEXT, policy: demoPolicy });

  await expect(
    confirmMandate(deps, { buyerId, text: TEXT, policy: { ...demoPolicy, expiresAt } }),
  ).rejects.toThrow('expiry');

  const rows = await allMandates(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: existing.mandateId, status: 'active' });
});

it('throws for a buyer that does not exist and stores nothing', async () => {
  const { db, deps } = await setup();

  await expect(
    confirmMandate(deps, { buyerId: crypto.randomUUID(), text: TEXT, policy: demoPolicy }),
  ).rejects.toThrow('buyer');

  expect(await allMandates(db)).toHaveLength(0);
});

it('locks the buyer row before it revokes the old mandate and inserts the new one', async () => {
  // PGlite runs one transaction at a time, so two racing confirms cannot show the lock at work.
  // Instead a second Drizzle instance over the test database's PGlite client logs each statement,
  // and their order shows the lock is taken before anything is written.
  const base = await createTestDb();
  const statements: string[] = [];
  const db: Db = drizzle({
    client: (base as unknown as { $client: PGlite }).$client,
    schema,
    logger: { logQuery: (query) => statements.push(query) },
  });
  const buyerId = await addBuyer(db);
  statements.length = 0;

  await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy });

  const lock = /^select .* from "buyers" where "buyers"\."id" = \$1 for update$/;
  const revoke = /^update "mandates" set "status" = \$1, .* where \("mandates"\."buyer_id" = \$\d+ and "mandates"\."status" = \$\d+\)$/;
  expect(statements).toEqual([
    expect.stringMatching(lock),
    expect.stringMatching(revoke),
    expect.stringMatching(/^insert into "mandates" /),
  ]);
});
