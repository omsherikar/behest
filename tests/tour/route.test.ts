import { connection } from 'next/server';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/tour/route';
import { appDb } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { NO_PINS } from '@/lib/tour/pins';
import { seedPurchase } from '@/tests/helpers/seed-purchase';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
}));

let db: Db;
let held: string;
const GONE = '0a1b2c3d-0000-4000-8000-0000000000ff';

beforeAll(async () => {
  db = await createTestDb();
  held = (await seedPurchase(db, 'settled')).purchaseId;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('serves the pinned ids, read on every request and never cached', async () => {
  vi.mocked(appDb).mockReturnValue(db);
  vi.stubEnv('TOUR_PINS', JSON.stringify({ held }));

  const response = await GET();

  expect(response.status).toBe(200);
  expect(connection).toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ pins: { ...NO_PINS, held } });
});

it('serves a pin whose record is gone as no pin, so its step says the data is not loaded', async () => {
  vi.mocked(appDb).mockReturnValue(db);
  vi.stubEnv('TOUR_PINS', JSON.stringify({ held, blocked: GONE, dispute: GONE }));
  expect(await (await GET()).json()).toEqual({ pins: { ...NO_PINS, held } });
});

it('serves no pins, rather than failing, when the database cannot be read', async () => {
  vi.mocked(appDb).mockImplementation(() => {
    throw new Error('DATABASE_URL is not set');
  });
  vi.stubEnv('TOUR_PINS', JSON.stringify({ held }));
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ pins: NO_PINS });
});

it('serves empty pins when the setting is not there', async () => {
  vi.mocked(appDb).mockReturnValue(db);
  vi.stubEnv('TOUR_PINS', '');
  expect(await (await GET()).json()).toEqual({ pins: NO_PINS });
});
