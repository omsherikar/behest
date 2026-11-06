import type { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/lib/db/client';

// A Pool connects lazily, so these tests never open a socket to this unreachable address.
const UNREACHABLE_POSTGRES = 'postgres://behest@127.0.0.1:1/behest';

function poolOf(db: ReturnType<typeof getDb>): Pool {
  return (db as unknown as { $client: Pool }).$client;
}

afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('closes the database so the next getDb() opens a new one', async () => {
  vi.stubEnv('DATABASE_URL', UNREACHABLE_POSTGRES);
  const db = getDb();
  await closeDb();
  expect(poolOf(db).ended).toBe(true);
  expect(getDb()).not.toBe(db);
});
