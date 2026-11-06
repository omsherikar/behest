import { closeDb, getDb, migrateDb } from '../lib/db/client';

// Applies pending migrations to the configured database: Postgres when DATABASE_URL is set,
// otherwise the local PGlite database. The database is closed before exit so PGlite shuts down
// cleanly and the Postgres pool releases its connections.

async function main() {
  try {
    await migrateDb(getDb());
  } finally {
    await closeDb();
  }
}

main().then(
  () => console.log('Migrations applied.'),
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
