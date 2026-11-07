import type { PurchaseStatus } from '@/lib/db/schema';
import type { Verdict } from '@/lib/domain/verdict';
import { plural } from '@/lib/domain/words';

// How the buyer's pages word a purchase and an agent run, in the same terms the shopping agent uses
// when it tells the buyer what happened. The status is what counts: an ALLOW verdict is not a payment.

const STATUS_WORDS: Record<PurchaseStatus, string> = {
  proposed: 'Being checked',
  charging: 'Confirming payment',
  awaiting_approval: 'Waiting for your approval',
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

const REASONS_HEADING: Record<Verdict, string> = {
  ALLOW: 'Why it was allowed',
  ASK: 'Why Behest asked you',
  BLOCK: 'Why it was blocked',
};

/**
 * The heading over a purchase's reasons, by its verdict. An allowed purchase's reasons are the intent
 * check's confirmation that the cart matches the request, not reasons it was held or refused.
 */
export function reasonsHeading(verdict: Verdict): string {
  return REASONS_HEADING[verdict];
}

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

/** The most characters of one argument the console shows. */
const ARG_MAX = 48;

/** One argument the agent chose, as the console writes it: text quoted and cut, cart items as `SKU x2`. */
function argument(value: unknown): string | null {
  if (typeof value === 'string') {
    const line = value.replaceAll(/\s+/g, ' ').trim();
    return JSON.stringify(line.length > ARG_MAX ? `${line.slice(0, ARG_MAX - 3).trim()}...` : line);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      const { sku, quantity } = typeof item === 'object' && item !== null ? (item as { sku?: unknown; quantity?: unknown }) : {};
      return typeof sku === 'string' && typeof quantity === 'number' ? `${sku.slice(0, ARG_MAX)} x${quantity}` : null;
    });
    return items.every((item) => item !== null) ? items.join(', ') : plural(value.length, 'item');
  }
  return null;
}

/**
 * A tool call's arguments as the agent console shows them, such as `query: "turmeric",
 * maxPriceCents: 2500`. The input is the agent's, so only plain values are written, each cut
 * short, and anything nested is left out. Empty when there is nothing to show.
 */
export function toolArgs(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  return Object.entries(input)
    .map(([key, value]) => {
      const shown = argument(value);
      return shown === null ? null : `${key.slice(0, ARG_MAX)}: ${shown}`;
    })
    .filter((arg): arg is string => arg !== null)
    .join(', ');
}

const REFUSALS = new Map<number, string>([
  [400, 'Behest could not read your request. Check it and try again.'],
  [401, 'Your session has ended. Pick the buyer persona on the home page.'],
  [403, 'Only the buyer can send the agent shopping. Pick the buyer persona on the home page.'],
  [413, 'Your request is too long. Keep it to 2,000 characters or fewer.'],
  [429, 'Your agent is busy. Wait a minute and try again.'],
]);
const NOT_STARTED = 'Behest could not start your agent. Try again in a minute.';

/**
 * What the buyer reads when the run route answers with an error instead of a run: the route's own
 * message, which says why, as a sentence, or plain words for the status when it sent none.
 */
export function runRefusal(status: number, body: unknown): string {
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  if (typeof message === 'string' && message.trim() !== '') {
    const text = message.trim();
    const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
    return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
  }
  return REFUSALS.get(status) ?? NOT_STARTED;
}

/** Whether a run's error is about the buyer's mandate, such as "Sign a mandate first.", so the page links to it. */
export function aboutMandate(message: string): boolean {
  return /\bmandate\b/i.test(message);
}
