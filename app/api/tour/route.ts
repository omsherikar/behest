import { connection } from 'next/server';
import { readPins } from '@/lib/tour/pins';

// The ids of the records the guided demo opens, from TOUR_PINS. Only the ids: what each record
// holds is read by the pages the tour opens, under the demo role each step switches to.

/** `GET`: `{ pins }`, each pin a record id or null. */
export async function GET() {
  // Reads TOUR_PINS from the environment on each request, never at build time.
  await connection();

  return Response.json({ pins: readPins(process.env.TOUR_PINS) }, { headers: { 'Cache-Control': 'no-store' } });
}
