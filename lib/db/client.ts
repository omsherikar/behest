import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { is } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite, PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

// Postgres when DATABASE_URL is set (production), otherwise PGlite on local disk (development).
// Tests build their own in-memory PGlite through tests/helpers/test-db.ts.

/** A Drizzle database over either driver. Code that takes a `Db` works the same on both. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Where local development keeps its PGlite database. Ignored by git. */
const LOCAL_DATA_DIR = path.join(process.cwd(), '.data', 'pglite');
const MIGRATIONS_FOLDER = path.join(process.cwd(), 'drizzle');

/** A Drizzle database over the given PGlite instance. */
export function pgliteDb(client: PGlite): Db {
  return drizzlePglite({ client, schema });
}

type DbHandle = { db: Db; close: () => Promise<void> };

function openDb(): DbHandle {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = new Pool({ connectionString: url });
    // An idle client losing its connection emits 'error' on the pool. Without a listener that
    // would crash the process; the pool replaces the client on the next query.
    pool.on('error', (error) => console.error(`Postgres pool error: ${error.message}`));
    return { db: drizzlePg({ client: pool, schema }), close: () => pool.end() };
  }
  // PGlite creates its data directory but not the parents.
  mkdirSync(LOCAL_DATA_DIR, { recursive: true });
  const client = new PGlite(LOCAL_DATA_DIR);
  return { db: pgliteDb(client), close: () => client.close() };
}

// Kept on globalThis so a dev server's module reloads reuse one pool and never open the PGlite
// data directory twice.
const globalForDb = globalThis as typeof globalThis & { behestDb?: DbHandle };

/** The app's database, created on first use. */
export function getDb(): Db {
  globalForDb.behestDb ??= openDb();
  return globalForDb.behestDb.db;
}

/** Closes the app's database if it is open. The next getDb() opens a new one. */
export async function closeDb(): Promise<void> {
  const handle = globalForDb.behestDb;
  globalForDb.behestDb = undefined;
  await handle?.close();
}

/** Applies every pending migration in `drizzle/` with the migrator that matches the driver. */
export async function migrateDb(db: Db): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (is(db, PgliteDatabase)) await migratePglite(db, config);
  else await migratePg(db as Parameters<typeof migratePg>[0], config);
}
