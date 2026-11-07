import type { Db } from '@/lib/db/client';

// Behest as a WebAuthn relying party: the site a buyer's passkey is bound to.

/** What the passkey ceremonies need: the database, Behest's public origin and the clock. */
export type PasskeyDeps = { db: Db; origin: string; now: () => Date };

/** Behest as the relying party at `origin`, the origin it is served from: its id is that hostname, `localhost` included. */
export function relyingParty(origin: string): { rpName: 'Behest'; rpID: string; origin: string } {
  return { rpName: 'Behest', rpID: new URL(origin).hostname, origin };
}
