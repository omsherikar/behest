import { getDb, migrateDb } from '../lib/db/client';

// Applies pending migrations to the configured database: Postgres when DATABASE_URL is set,
// otherwise the local PGlite database.

async function main() {
  const db = getDb();
  await migrateDb(db);
  console.log('Migrations applied.');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
