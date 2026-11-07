import { connection } from 'next/server';
import { appJwks } from '@/lib/app-deps';

// Behest's public key set, which verifies every mandate and receipt it signs. Sellers fetch it to
// check receipts on their own, without asking Behest anything else.

/** How long a client may keep the key set before fetching it again, in seconds. */
const MAX_AGE_SECONDS = 300;

/** `GET`: the public key set as a JWKS. */
export async function GET() {
  // Reads the signing key from the environment on each request, never at build time.
  await connection();

  return Response.json(await appJwks(), { headers: { 'Cache-Control': `public, max-age=${MAX_AGE_SECONDS}` } });
}
