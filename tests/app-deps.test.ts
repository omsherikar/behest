import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buyers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createTestDb } from '@/tests/helpers/test-db';

vi.mock('@/lib/db/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/client')>()),
  getDb: vi.fn(),
}));

/** The module as a fresh process sees it, with nothing loaded or kept yet. */
async function freshAppDeps() {
  vi.resetModules();
  return import('@/lib/app-deps');
}

const keyA = await generateSigningKey();
const keyB = await generateSigningKey();
const jwksOf = async (pem: string) => publicJwks([await loadSigningKey({ RECEIPT_SIGNING_KEY: pem })]);

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('demoBuyerId', () => {
  it('creates the demo buyer when there is none, then keeps returning it', async () => {
    const { demoBuyerId } = await freshAppDeps();
    const db = await createTestDb();

    const id = await demoBuyerId(db);

    expect(await demoBuyerId(db)).toBe(id);
    expect(await db.select().from(buyers)).toEqual([expect.objectContaining({ id, name: DEMO_BUYER_NAME })]);
  });

  it('returns the oldest buyer with the demo name and creates nothing', async () => {
    const { demoBuyerId } = await freshAppDeps();
    const db = await createTestDb();
    await db.insert(buyers).values({ name: 'Arjun', createdAt: new Date('2026-11-01T00:00:00Z') });
    await db.insert(buyers).values({ name: DEMO_BUYER_NAME, createdAt: new Date('2026-11-03T00:00:00Z') });
    const [oldest] = await db
      .insert(buyers)
      .values({ name: DEMO_BUYER_NAME, createdAt: new Date('2026-11-02T00:00:00Z') })
      .returning();

    expect(await demoBuyerId(db)).toBe(oldest.id);
    expect(await db.select().from(buyers).where(eq(buyers.name, DEMO_BUYER_NAME))).toHaveLength(2);
  });
});

describe('appUrl', () => {
  it('reads APP_URL without its trailing slashes', async () => {
    const { appUrl } = await freshAppDeps();
    vi.stubEnv('APP_URL', 'https://behest.example.com//');
    expect(appUrl()).toBe('https://behest.example.com');
  });

  it.each(['', '   ', 'not a url'])('refuses an APP_URL of %j', async (value) => {
    const { appUrl } = await freshAppDeps();
    vi.stubEnv('APP_URL', value);
    expect(() => appUrl()).toThrow(/APP_URL/);
  });
});

describe('appSigner and appJwks', () => {
  it('load the key from the environment once and keep it', async () => {
    const { appSigner, appJwks } = await freshAppDeps();
    vi.stubEnv('RECEIPT_SIGNING_KEY', keyA.pem);
    const first = await appSigner();

    vi.stubEnv('RECEIPT_SIGNING_KEY', keyB.pem);

    expect(await (await appSigner()).jwks()).toEqual(await first.jwks());
    expect(await appJwks()).toEqual(await jwksOf(keyA.pem));
  });

  it('do not keep a failed load, so a later call loads the key once it is set', async () => {
    const { appSigner, appJwks } = await freshAppDeps();
    vi.stubEnv('RECEIPT_SIGNING_KEY', '');
    await expect(appSigner()).rejects.toThrow(/RECEIPT_SIGNING_KEY/);

    vi.stubEnv('RECEIPT_SIGNING_KEY', keyB.pem);

    expect(await appJwks()).toEqual(await jwksOf(keyB.pem));
  });
});

describe('appPaypal', () => {
  it('assembles the live PayPal client functions', async () => {
    const { appPaypal } = await freshAppDeps();
    // The client modules app-deps loaded, not the ones a static import made before the reset.
    const [vault, orders, payouts, refunds, disputes, webhooks] = await Promise.all([
      import('@/lib/paypal/vault'),
      import('@/lib/paypal/orders'),
      import('@/lib/paypal/payouts'),
      import('@/lib/paypal/refunds'),
      import('@/lib/paypal/disputes'),
      import('@/lib/paypal/webhooks'),
    ]);

    expect(appPaypal()).toEqual({
      createSetupToken: vault.createSetupToken,
      createPaymentToken: vault.createPaymentToken,
      chargeSavedWallet: orders.chargeSavedWallet,
      createApprovalOrder: orders.createApprovalOrder,
      captureOrder: orders.captureOrder,
      createPayout: payouts.createPayout,
      getPayoutBatch: payouts.getPayoutBatch,
      refundCapture: refunds.refundCapture,
      listDisputes: disputes.listDisputes,
      getDispute: disputes.getDispute,
      provideEvidence: disputes.provideEvidence,
      verifyWebhook: webhooks.verifyWebhook,
    });
  });
});

describe('appDb and llmDeps', () => {
  it('hand out the app database, a Claude client and the system clock', async () => {
    const { appDb, llmDeps } = await freshAppDeps();
    // The database module app-deps loaded, not the one this file imported before the reset.
    const { getDb } = await import('@/lib/db/client');
    const db = await createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');

    const deps = llmDeps();

    expect(appDb()).toBe(db);
    expect(deps.db).toBe(db);
    expect(deps.claude).toBeInstanceOf(Anthropic);
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1_000);
  });
});
