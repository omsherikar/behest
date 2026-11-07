import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buyers, llmCalls, sellers } from '@/lib/db/schema';
import { DEMO_BUYER_NAME } from '@/lib/demo/personas';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { raviCart, receiptFor } from '@/tests/helpers/receipts';
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

  it.each([
    '',
    '   ',
    'not a url',
    'ftp://behest.example.com',
    'javascript:alert(1)',
    'mailto:ops@behest.example.com',
    'https://behest.example.com/app',
    'https://behest.example.com/app/',
    'https://behest.example.com/?ref=1',
    'https://behest.example.com?',
    'https://behest.example.com/#top',
    'https://behest.example.com#',
  ])('refuses an APP_URL of %j', async (value) => {
    const { appUrl } = await freshAppDeps();
    vi.stubEnv('APP_URL', value);
    expect(() => appUrl()).toThrow(
      'APP_URL must be the http or https origin Behest is served from, with no path, query or fragment',
    );
  });

  it('gives the origin in its usual form', async () => {
    const { appUrl } = await freshAppDeps();
    vi.stubEnv('APP_URL', 'HTTPS://Behest.Example.com:443/');
    expect(appUrl()).toBe('https://behest.example.com');
  });

  it('accepts an http URL, for local development', async () => {
    const { appUrl } = await freshAppDeps();
    vi.stubEnv('APP_URL', 'http://localhost:3000/');
    expect(appUrl()).toBe('http://localhost:3000');
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
  it.each(['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'])('refuses to start without %s', async (name) => {
    const { appPaypal } = await freshAppDeps();
    vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
    vi.stubEnv(name, '');
    expect(() => appPaypal()).toThrow('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
  });

  it('assembles the live PayPal client functions', async () => {
    const { appPaypal } = await freshAppDeps();
    vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
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

describe('purchaseDeps', () => {
  it('hands the purchase flow the app database, PayPal, key, sellers, origin and clock, and checks intent on the model', async () => {
    const app = await freshAppDeps();
    const { getDb } = await import('@/lib/db/client');
    const db = await createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
    vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('RECEIPT_SIGNING_KEY', keyA.pem);
    vi.stubEnv('APP_URL', 'https://behest.example.com/');
    vi.stubEnv('LLM_STUB', '1');

    const deps = await app.purchaseDeps();

    expect(deps.db).toBe(db);
    expect(deps.paypal).toEqual(app.appPaypal());
    expect(await deps.signer.jwks()).toEqual(await jwksOf(keyA.pem));
    expect(deps.sellers.acceptAgentOrder).toEqual(expect.any(Function));
    expect(deps.appUrl).toBe('https://behest.example.com');
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1_000);
    const check = {
      mandateText: 'Spices only',
      readback: ['Spices only.'],
      request: 'Buy turmeric',
      cart: raviCart,
      agentRationale: 'The buyer asked for turmeric.',
    };
    // LLM_STUB replays the recorded intent check, which is logged like any model call.
    expect(await deps.intent(check)).toMatchObject({ verdict: 'consistent' });
    expect(await db.select().from(llmCalls)).toEqual([expect.objectContaining({ route: 'intent_check', ok: true })]);
  });

  it('refuses to start without the PayPal credentials', async () => {
    const { purchaseDeps } = await freshAppDeps();
    vi.stubEnv('PAYPAL_CLIENT_ID', '');

    await expect(purchaseDeps()).rejects.toThrow('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
  });
});

describe('sellerDeps and appSellerPort', () => {
  it('give seller intake the app database, the app key set and the system clock', async () => {
    const { sellerDeps } = await freshAppDeps();
    const { getDb } = await import('@/lib/db/client');
    const db = await createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    vi.stubEnv('RECEIPT_SIGNING_KEY', keyA.pem);

    const deps = sellerDeps();

    expect(deps.db).toBe(db);
    expect(await deps.jwks()).toEqual(await jwksOf(keyA.pem));
    expect(Math.abs(deps.now().getTime() - Date.now())).toBeLessThan(1_000);
  });

  it('hand an agent order to seller intake, which takes a receipt signed with the app key once', async () => {
    const { appSellerPort } = await freshAppDeps();
    const { getDb } = await import('@/lib/db/client');
    const db = await createTestDb();
    vi.mocked(getDb).mockReturnValue(db);
    vi.stubEnv('RECEIPT_SIGNING_KEY', keyA.pem);
    await db.insert(sellers).values({ slug: 'ravi-spices', name: "Ravi's Spice Co.", payoutEmail: 'ravi@example.com' });
    const signer = createSigner(await loadSigningKey({ RECEIPT_SIGNING_KEY: keyA.pem }));
    // Issued on the whole second just past, so it is fresh on the system clock.
    const issued = new Date(Math.floor(Date.now() / 1000) * 1000);
    const receiptJws = await signer.sign(receiptFor(raviCart, issued), 'behest-receipt+jws');
    const order = { sellerSlug: 'ravi-spices', cart: raviCart, receiptJws };

    expect(await appSellerPort().acceptAgentOrder(order)).toEqual({ status: 'accepted' });
    expect(await appSellerPort().acceptAgentOrder(order)).toEqual({ status: 'rejected', reason: 'replayed' });
  });
});
