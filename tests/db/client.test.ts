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

it('refuses to fall back to a local database in production', () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('DATABASE_URL', undefined);
  expect(() => getDb()).toThrow('DATABASE_URL is required in production');
});

it('logs Postgres pool errors instead of crashing', () => {
  vi.stubEnv('DATABASE_URL', UNREACHABLE_POSTGRES);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const pool = poolOf(getDb());
  pool.emit('error', new Error('terminating connection due to administrator command'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('terminating connection due to administrator command'));
});

it('closes the database so the next getDb() opens a new one', async () => {
  vi.stubEnv('DATABASE_URL', UNREACHABLE_POSTGRES);
  const db = getDb();
  await closeDb();
  expect(poolOf(db).ended).toBe(true);
  expect(getDb()).not.toBe(db);
});
