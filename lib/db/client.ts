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

function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (url) return drizzlePg({ client: new Pool({ connectionString: url }), schema });
  // PGlite creates its data directory but not the parents.
  mkdirSync(LOCAL_DATA_DIR, { recursive: true });
  return pgliteDb(new PGlite(LOCAL_DATA_DIR));
}

// Kept on globalThis so a dev server's module reloads reuse one pool and never open the PGlite
// data directory twice.
const globalForDb = globalThis as typeof globalThis & { behestDb?: Db };

/** The app's database, created on first use. */
export function getDb(): Db {
  globalForDb.behestDb ??= createDb();
  return globalForDb.behestDb;
}

/** Applies every pending migration in `drizzle/` with the migrator that matches the driver. */
export async function migrateDb(db: Db): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (is(db, PgliteDatabase)) await migratePglite(db, config);
  else await migratePg(db as Parameters<typeof migratePg>[0], config);
}
