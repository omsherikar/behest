import { plural } from '@/lib/domain/words';
import { CSV_MB, PHOTO_MB, PHOTOS_MB } from './onboard-request';

// What the seller onboarding page tells the seller after POST /api/sellers/onboard answers. Each
// status the route can return gets its own plain words. Only a 400 carries a message meant for the
// seller, so that is the only server text shown; any other text the server sends is ignored.

export type OnboardOutcome =
  | {
      ok: true;
      headline: string;
      /** Why some listings are hidden from agents, or null when none is. */
      flaggedNote: string | null;
      /** Each CSV row that could not be listed, as `Line 4: why.` */
      rejected: string[];
    }
  | {
      ok: false;
      message: string;
      /** Whether the page should reload its data: the shop may exist now, or already did. */
      refresh: boolean;
    };

const UNREADABLE = 'Behest sent an answer this page could not read. Reload the page to see whether your shop was onboarded.';
const BAD_REQUEST = 'Behest could not accept that upload. Check your details and files, then try again.';

const FAILURES = new Map<number | null, string>([
  [null, 'Could not reach Behest. Check your connection and try again.'],
  [401, 'Your session has ended. Pick the seller persona on the home page, then try again.'],
  [403, 'Only the seller persona can onboard a shop. Pick it on the home page.'],
  [409, 'A shop with this slug is already onboarded, so nothing new was saved.'],
  [
    413,
    `That upload is too large. A catalog CSV can be ${CSV_MB} MB, and photos about ${PHOTO_MB} MB each and ${PHOTOS_MB} MB together, so use fewer photos or a smaller CSV file.`,
  ],
  [429, 'Too many uploads in a short time. Wait a minute, then try again.'],
  [502, 'Behest could not build your catalog just now, so nothing was saved. Try again in a minute.'],
]);
const SERVER_FAULT = "Something went wrong on Behest's side. Reload the page to see whether your shop was onboarded before you try again.";

type Listed = { created: number; flagged: number; rejected: { line: number; reason: string }[] };

/**
 * The outcome to show for the route's HTTP status and parsed JSON body. Any 2xx is success (the
 * route answers 201). `status` is null when the request never got an answer.
 */
export function onboardOutcome(status: number | null, body: unknown): OnboardOutcome {
  if (status !== null && status >= 200 && status < 300) {
    return isListed(body) ? listedOutcome(body) : { ok: false, message: UNREADABLE, refresh: true };
  }
  if (status === 400) return { ok: false, message: serverMessage(body) ?? BAD_REQUEST, refresh: false };
  return { ok: false, message: FAILURES.get(status) ?? SERVER_FAULT, refresh: status === 409 };
}

function listedOutcome({ created, flagged, rejected }: Listed): OnboardOutcome {
  const one = flagged === 1;
  return {
    ok: true,
    headline: `Your shop is onboarded with ${plural(created, 'listing')}.`,
    flaggedNote:
      flagged === 0
        ? null
        : `${plural(flagged, 'listing')} ${one ? 'is' : 'are'} hidden from agents because ${one ? 'its' : 'their'} text speaks to AI agents. Shopping agents cannot see or buy ${one ? 'it' : 'them'}.`,
    rejected: rejected.map(({ line, reason }) => sentence(`Line ${line}: ${reason}`)),
  };
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isListed(body: unknown): body is Listed {
  if (typeof body !== 'object' || body === null) return false;
  const { created, flagged, rejected } = body as Record<string, unknown>;
  return (
    isCount(created) &&
    isCount(flagged) &&
    Array.isArray(rejected) &&
    rejected.every(
      (row: unknown) =>
        typeof row === 'object' &&
        row !== null &&
        isCount((row as { line?: unknown }).line) &&
        typeof (row as { reason?: unknown }).reason === 'string',
    )
  );
}

/** The `{ error: { message } }` a route sends, as a sentence, or null when there is none. */
function serverMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? sentence(message.trim()) : null;
}

/** Text as a sentence: capitalized, with a full stop unless it already ends a sentence. */
function sentence(text: string): string {
  const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
