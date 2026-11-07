import type { PurchaseStatus } from '@/lib/db/schema';
import { plural } from '@/lib/domain/words';

// How the buyer's pages word a purchase and an agent run, in the same terms the shopping agent uses
// when it tells the buyer what happened. The status is what counts: an ALLOW verdict is not a payment.

const STATUS_WORDS: Record<PurchaseStatus, string> = {
  proposed: 'Being checked',
  charging: 'Confirming payment',
  awaiting_approval: 'Approve at PayPal',
  captured: 'Paid',
  accepted: 'Paid',
  settled: 'Paid',
  disputed: 'Paid, in dispute',
  resolved: 'Paid, dispute closed',
  refunded: 'Refunded',
  blocked: 'Not bought',
  failed: 'Not bought',
  cancelled: 'Not bought, approval cancelled',
};

/** A purchase status in the buyer's words, such as "Paid" for `captured`. A status Behest does not know is given as it is. */
export function statusWords(status: string): string {
  return Object.hasOwn(STATUS_WORDS, status) ? STATUS_WORDS[status as PurchaseStatus] : status;
}

/** The most characters of the agent's own text a step quotes. */
const QUOTE_MAX = 80;

/** A field of the agent's tool input as one line of at most 80 characters, or null when it is not text or is blank. */
function quoted(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  const line = value.replaceAll(/\s+/g, ' ').trim();
  if (line === '') return null;
  return line.length > QUOTE_MAX ? `${line.slice(0, QUOTE_MAX - 3).trim()}...` : line;
}

/** How many units a proposal's items add up to, or null unless each has a whole, positive quantity. */
function units(input: unknown): number | null {
  const items = typeof input === 'object' && input !== null ? (input as { items?: unknown }).items : undefined;
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    const quantity = typeof item === 'object' && item !== null ? (item as { quantity?: unknown }).quantity : undefined;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) return null;
    total += quantity;
  }
  return total;
}

/**
 * One step of an agent run, in words, from the tool the agent called and the input it chose, such
 * as `Searching Behest sellers for "turmeric"`. The input is the agent's, so only plain fields are
 * read from it, each cut to one short line.
 */
export function toolStep(name: string, input: unknown): string {
  switch (name) {
    case 'search_sellers': {
      const query = quoted(input, 'query');
      return query ? `Searching Behest sellers for "${query}"` : 'Searching every Behest listing';
    }
    case 'search_market': {
      const query = quoted(input, 'query');
      return query ? `Checking market prices for "${query}"` : 'Checking market prices';
    }
    case 'get_product': {
      const [sku, seller] = [quoted(input, 'sku'), quoted(input, 'sellerSlug')];
      return sku && seller ? `Reading listing ${sku} at ${seller}` : 'Reading a listing';
    }
    case 'propose_purchase': {
      const [count, seller] = [units(input), quoted(input, 'sellerSlug')];
      const what = count === null ? 'a purchase' : plural(count, 'item');
      return seller ? `Proposing ${what} from ${seller}` : `Proposing ${what}`;
    }
    default:
      return `Using ${name}`;
  }
}
