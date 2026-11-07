import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueTicket, readTicket, TICKET_SECONDS, ticketExpiry } from '@/lib/passkeys/ticket';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const BUYER = 'b'.repeat(64);

const signing = { kind: 'mandate_sign' as const, buyer: BUYER, nonce: 'bm9uY2U', exp: NOW_SECONDS + TICKET_SECONDS };
const registering = { kind: 'passkey_register' as const, buyer: BUYER, challenge: 'Y2hhbGxlbmdl', exp: NOW_SECONDS + TICKET_SECONDS };

beforeEach(() => vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-characters'));
afterEach(() => vi.unstubAllEnvs());

it('lasts five minutes from the whole second it was issued in', () => {
  expect(TICKET_SECONDS).toBe(300);
  expect(ticketExpiry(new Date('2026-11-06T10:00:00.900Z'))).toBe(NOW_SECONDS + 300);
});

it('reads back the claims of a ticket it issued, of the kind asked for', () => {
  expect(readTicket(issueTicket(signing), 'mandate_sign', NOW)).toEqual(signing);
  expect(readTicket(issueTicket(registering), 'passkey_register', NOW)).toEqual(registering);
});

it('reads a ticket up to the second before it expires, and not from then on', () => {
  const ticket = issueTicket(signing);
  expect(readTicket(ticket, 'mandate_sign', new Date((signing.exp - 1) * 1000))).toEqual(signing);
  expect(readTicket(ticket, 'mandate_sign', new Date(signing.exp * 1000))).toBeNull();
  expect(readTicket(ticket, 'mandate_sign', new Date((signing.exp + 60) * 1000))).toBeNull();
});

it('refuses a ticket issued for the other kind', () => {
  expect(readTicket(issueTicket(registering), 'mandate_sign', NOW)).toBeNull();
  expect(readTicket(issueTicket(signing), 'passkey_register', NOW)).toBeNull();
});

it('refuses a ticket whose claims or MAC were changed', () => {
  const [body, mac] = issueTicket(signing).split('.');
  const later = Buffer.from(JSON.stringify({ ...signing, exp: signing.exp + 3600 })).toString('base64url');
  expect(readTicket(`${later}.${mac}`, 'mandate_sign', NOW)).toBeNull();
  expect(readTicket(`${body}.${mac.slice(0, -2)}AA`, 'mandate_sign', NOW)).toBeNull();
  expect(readTicket(`${body}.`, 'mandate_sign', NOW)).toBeNull();
});

it('refuses a ticket made under another secret', () => {
  const ticket = issueTicket(signing);
  vi.stubEnv('SESSION_SECRET', 'another-session-secret-at-least-32-characters');
  expect(readTicket(ticket, 'mandate_sign', NOW)).toBeNull();
});

it.each([undefined, null, 42, '', 'not-a-ticket', 'a.b.c', {}])('refuses %j as a ticket', (ticket) => {
  expect(readTicket(ticket, 'mandate_sign', NOW)).toBeNull();
});

it('refuses well-signed claims that are not a ticket of its kind', () => {
  const extra = issueTicket({ ...signing, policyHash: 'x' } as typeof signing);
  expect(readTicket(extra, 'mandate_sign', NOW)).toBeNull();
});

it('needs SESSION_SECRET to issue or read a ticket', () => {
  const ticket = issueTicket(signing);
  vi.stubEnv('SESSION_SECRET', '');
  expect(() => issueTicket(signing)).toThrow(/SESSION_SECRET/);
  expect(() => readTicket(ticket, 'mandate_sign', NOW)).toThrow(/SESSION_SECRET/);
});
