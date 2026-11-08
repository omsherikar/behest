import { connection } from 'next/server';
import { appDb } from '@/lib/app-deps';
import { pinsThatExist } from '@/lib/tour/existing';
import { NO_PINS, readPins } from '@/lib/tour/pins';

// The ids of the records the guided demo opens, from TOUR_PINS, keeping only those whose records
// are still in the database. Only the ids: what each record holds is read by the pages the tour
// opens, under the demo role each step switches to.

/** `GET`: `{ pins }`, each pin a record id or null. */
export async function GET() {
  // Reads TOUR_PINS and the database on each request, never at build time.
  await connection();

  let pins = NO_PINS;
  try {
    pins = await pinsThatExist(appDb(), readPins(process.env.TOUR_PINS));
  } catch (error) {
    // Without the database the tour still runs: every step shows its card, without a ring.
    console.error(`Could not check the guided demo's pinned records: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Response.json({ pins }, { headers: { 'Cache-Control': 'no-store' } });
}
