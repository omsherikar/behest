import { afterEach, expect, it, vi } from 'vitest';
import { appDb, appPaypal, appSellerPort, appSigner } from '@/lib/app-deps';
import { jobHandlers } from '@/lib/jobs/handlers';
import { runPeriodicPass } from '@/lib/jobs/periodic';
import { loadJobHandlers } from '@/lib/jobs/registry';

// Stand-ins for the app's live dependencies, so this covers only how the registry assembles them.
const live = vi.hoisted(() => ({ db: { name: 'app database' }, paypal: { name: 'PayPal' }, signer: { name: 'signer' }, sellers: { name: 'sellers' } }));
vi.mock('@/lib/app-deps', () => ({
  appDb: vi.fn(() => live.db),
  appPaypal: vi.fn(() => live.paypal),
  appSigner: vi.fn(async () => live.signer),
  appSellerPort: vi.fn(() => live.sellers),
}));

afterEach(() => {
  vi.clearAllMocks();
});

it("gives the worker every job kind's handler, the periodic pass and the app's live dependencies", async () => {
  const runtime = await loadJobHandlers();

  expect(runtime.handlers).toBe(jobHandlers);
  expect(Object.keys(runtime.handlers).sort()).toEqual(['approval_expiry', 'charge_retry', 'dispute_sync', 'payout_poll', 'webhook']);
  expect(runtime.periodic).toBe(runPeriodicPass);
  expect(runtime.deps).toMatchObject({ db: live.db, paypal: live.paypal, signer: live.signer, sellers: live.sellers });
  const before = Date.now();
  const now = runtime.deps.now().getTime();
  expect(now).toBeGreaterThanOrEqual(before);
  expect(now).toBeLessThanOrEqual(Date.now());
  for (const factory of [appDb, appPaypal, appSigner, appSellerPort]) expect(factory).toHaveBeenCalledOnce();
});

it('fails, for the worker to try again on its next tick, when PayPal cannot be set up', async () => {
  vi.mocked(appPaypal).mockImplementationOnce(() => {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
  });

  await expect(loadJobHandlers()).rejects.toThrow('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set');
});
