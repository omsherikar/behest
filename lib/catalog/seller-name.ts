import { sql } from 'drizzle-orm';
import type { Db } from '@/lib/db/client';
import { sellers } from '@/lib/db/schema';
import { screenText } from './screen';

// What onboarding checks a new seller's name and shop address against. A buyer, and the shopping
// agent, know a seller by its name, so a new seller may not take a name that reads the same as an
// existing seller's: "Ravi's Spice Co" next to "Ravi's Spice Co." would let one pass for the other. And
// the agent reads the name and the address too, so either one written as instructions to AI agents is
// refused, by the phrases that flag a listing.

/** Company suffixes a name may end with, longest first. One is taken off before names are compared. */
const SUFFIXES = ['company', 'inc', 'llc', 'ltd', 'co'];

/**
 * The name as names are compared: compatibility forms such as full-width letters folded (NFKC),
 * case folded, everything but letters and digits removed, then one trailing company suffix taken
 * off, unless the name is nothing but the suffix. `Ravi's Spice Co.` and `RAVIS SPICE COMPANY` both
 * read as `ravisspice`. Accented and look-alike letters from other scripts are kept as they are.
 */
export function sellerNameKey(name: string): string {
  // Upper then lower case, so that, for one, `ß` folds to `ss` as it does in full case folding.
  const folded = name.normalize('NFKC').toUpperCase().toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const suffix = SUFFIXES.find((s) => folded.endsWith(s) && folded.length > s.length);
  return suffix === undefined ? folded : folded.slice(0, -suffix.length);
}

export type SellerNameRefusal =
  /** An existing seller, named here, has a name that reads the same. */
  | { code: 'name_taken'; existing: string }
  /** The name or the address speaks to AI agents; the phrases are what the screen matched. */
  | { code: 'name_screened'; phrases: string[] };

/**
 * Why a seller called `name` at the address `slug` may not be onboarded, or null when it may. The name
 * and the address, read as words, are screened together as a listing's name and description are; then
 * the name is compared with every existing seller's by sellerNameKey. Behest has few sellers, so they
 * are compared here rather than through a stored key.
 */
export async function sellerNameRefusal(db: Db, name: string, slug: string): Promise<SellerNameRefusal | null> {
  const screening = screenText(`${name}\n${slug.replaceAll('-', ' ')}`);
  if (screening.suspicious) return { code: 'name_screened', phrases: screening.matches };
  const key = sellerNameKey(name);
  const existing = await db.select({ name: sellers.name }).from(sellers);
  const clash = existing.find((seller) => sellerNameKey(seller.name) === key);
  return clash ? { code: 'name_taken', existing: clash.name } : null;
}

/**
 * Holds every other onboarding of a name with the same key until the transaction ends, so that two
 * sellers whose names read the same cannot both check, find no clash, and be stored.
 */
export async function lockSellerName(tx: Db, name: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${sellerNameKey(name)}))`);
}
