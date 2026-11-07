import { appDb } from '../lib/app-deps';
import { closeDb } from '../lib/db/client';
import { DEMO_BUYER_NAME } from '../lib/demo/personas';
import { seedDemo } from '../lib/demo/seed';

// Seeds the demo into the database the app uses: Postgres when DATABASE_URL is set, otherwise the
// local PGlite database. Run the migrations first. PAYEE_EMAIL must name the sandbox account that
// receives seller payouts. Seeding again leaves the same rows, and no model or market call is made.

async function main() {
  try {
    return await seedDemo(appDb(), { payeeEmail: process.env.PAYEE_EMAIL ?? '' });
  } finally {
    await closeDb();
  }
}

main().then(
  ({ sellers, products, flagged }) =>
    console.log(`Seeded the demo: buyer ${DEMO_BUYER_NAME}, ${sellers} sellers, ${products} products (${flagged} flagged).`),
  (error: unknown) => {
    console.error(`Seeding the demo failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
