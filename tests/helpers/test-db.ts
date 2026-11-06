import { PGlite } from '@electric-sql/pglite';
import type { Logger } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrateDb, pgliteDb, type Db } from '@/lib/db/client';
import * as schema from '@/lib/db/schema';

// Migrating a fresh PGlite takes over a second, so each test file migrates one template database
// once and every createTestDb() call starts a new instance from a copy of its data directory.

let template: Promise<File | Blob> | undefined;

async function migratedTemplate(): Promise<File | Blob> {
  const client = new PGlite();
  await migrateDb(pgliteDb(client));
  const dump = await client.dumpDataDir('none');
  await client.close();
  return dump;
}

/**
 * A fresh in-memory database with every migration applied. Each call is fully isolated. A `logger`
 * is handed every statement the database runs, for tests that check which statements a call sends.
 */
export async function createTestDb(options: { logger?: Logger } = {}): Promise<Db> {
  template ??= migratedTemplate();
  const client = new PGlite({ loadDataDir: await template });
  return options.logger ? drizzle({ client, schema, logger: options.logger }) : pgliteDb(client);
}
