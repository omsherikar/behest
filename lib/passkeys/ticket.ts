import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@/lib/receipts/canonical';

// Short-lived tickets that carry a passkey ceremony from the route that starts it to the route that
// finishes it. Behest issues every challenge and keeps nothing between the two requests: the ticket
// holds what the second request checks against, under an HMAC keyed by SESSION_SECRET, so the
// browser can carry a ticket but never make or change one, and never choose its own challenge.

/** How long a ticket lasts: five minutes. */
export const TICKET_SECONDS = 5 * 60;

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** A hash of the buyer id, as a signed mandate names the buyer. */
const buyerRef = z.string().regex(/^[0-9a-f]{64}$/);
/** When the ticket expires, in whole seconds since the epoch. */
const expiry = z.number().int().nonnegative();

const RegisterTicket = z
  .object({ kind: z.literal('passkey_register'), buyer: buyerRef, challenge: base64url, exp: expiry })
  .strict();
const SignTicket = z.object({ kind: z.literal('mandate_sign'), buyer: buyerRef, nonce: base64url, exp: expiry }).strict();

/** A ticket for registering a passkey: the challenge Behest issued for it. */
export type RegisterTicket = z.infer<typeof RegisterTicket>;
/** A ticket for signing a mandate with a passkey: the nonce and expiry the challenge commits to. */
export type SignTicket = z.infer<typeof SignTicket>;
type Ticket = RegisterTicket | SignTicket;
type TicketKind = Ticket['kind'];

const SCHEMAS: { [K in TicketKind]: z.ZodType<Extract<Ticket, { kind: K }>> } = {
  passkey_register: RegisterTicket,
  mandate_sign: SignTicket,
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error('SESSION_SECRET is required to issue and read passkey tickets');
  return value;
}

/** The MAC of a ticket's body, prefixed with what it is, so that no other HMAC of the secret, such as a confirm token, can pass for one. */
function macOf(body: string): Buffer {
  return createHmac('sha256', secret()).update(`behest-passkey-ticket.${body}`).digest();
}

/** A ticket holding `claims`: their canonical JSON and its MAC, each base64url, joined by a dot. */
export function issueTicket(claims: Ticket): string {
  const body = Buffer.from(canonicalJson(claims)).toString('base64url');
  return `${body}.${macOf(body).toString('base64url')}`;
}

/**
 * The claims of `ticket` when Behest issued it as a ticket of `kind` and it has not expired at `now`,
 * which is up to the second before its `exp`; otherwise null. The MAC is compared in constant time.
 */
export function readTicket<K extends TicketKind>(ticket: unknown, kind: K, now: Date): Extract<Ticket, { kind: K }> | null {
  // Before anything else, so a missing secret is a configuration error and never a refused ticket.
  secret();
  if (typeof ticket !== 'string') return null;
  const parts = ticket.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const given = Buffer.from(mac, 'base64url');
  const expected = macOf(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = SCHEMAS[kind].safeParse(claims);
  if (!parsed.success) return null;
  return now.getTime() < parsed.data.exp * 1000 ? parsed.data : null;
}
