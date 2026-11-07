import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { buyerPasskeys, buyers } from '@/lib/db/schema';
import { registerPasskey, registrationOptions, relyingParty } from '@/lib/passkeys/register';
import { readTicket } from '@/lib/passkeys/ticket';
import { sha256Hex } from '@/lib/receipts/canonical';
import { TestAuthenticator } from '@/tests/helpers/authenticator';
import { createTestDb } from '@/tests/helpers/test-db';

const ORIGIN = 'https://behest.test';
const NOW = new Date('2026-11-06T10:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;

let db: Db;
let buyerId: string;
const deps = (now = NOW) => ({ db, origin: ORIGIN, now: () => now });

async function addBuyer(name: string): Promise<string> {
  const [buyer] = await db.insert(buyers).values({ name }).returning();
  return buyer.id;
}

/** Registers a new software passkey for `buyer` through both steps. */
async function registered(buyer = buyerId): Promise<TestAuthenticator> {
  const authenticator = new TestAuthenticator(ORIGIN);
  const { options, ticket } = await registrationOptions(deps(), buyer);
  expect(await registerPasskey(deps(), { buyerId: buyer, response: authenticator.register(options), ticket })).toEqual({
    ok: true,
    credentialId: authenticator.credentialId,
  });
  return authenticator;
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-characters');
  db = await createTestDb();
  buyerId = await addBuyer('Priya');
});

afterEach(() => vi.unstubAllEnvs());

describe('relyingParty', () => {
  it('is Behest at the origin it is served from, with that hostname as its id', () => {
    expect(relyingParty(ORIGIN)).toEqual({ rpName: 'Behest', rpID: 'behest.test', origin: ORIGIN });
    expect(relyingParty('http://localhost:3000')).toEqual({ rpName: 'Behest', rpID: 'localhost', origin: 'http://localhost:3000' });
  });
});

describe('registrationOptions', () => {
  it('asks for a passkey with no attestation, preferring user verification, for the buyer by name', async () => {
    const { options } = await registrationOptions(deps(), buyerId);

    expect(options).toMatchObject({
      rp: { name: 'Behest', id: 'behest.test' },
      user: { name: 'Priya', displayName: 'Priya', id: createHash('sha256').update(buyerId).digest('base64url') },
      attestation: 'none',
      timeout: 300_000,
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: [],
    });
    expect(options.pubKeyCredParams).toContainEqual({ alg: -7, type: 'public-key' });
  });

  it('hands out a five-minute ticket for the buyer that holds the challenge it issued', async () => {
    const { options, ticket } = await registrationOptions(deps(), buyerId);

    expect(readTicket(ticket, 'passkey_register', NOW)).toEqual({
      kind: 'passkey_register',
      buyer: sha256Hex(buyerId),
      challenge: options.challenge,
      exp: NOW_SECONDS + 300,
    });
  });

  it("excludes the buyer's own passkeys, and no one else's", async () => {
    const own = await registered();
    await registered(await addBuyer('Sam'));

    const { options } = await registrationOptions(deps(), buyerId);

    expect(options.excludeCredentials).toEqual([{ id: own.credentialId, type: 'public-key', transports: ['internal'] }]);
  });

  it('refuses a buyer that does not exist', async () => {
    await expect(registrationOptions(deps(), crypto.randomUUID())).rejects.toThrow(/buyer/);
  });
});

describe('registerPasskey', () => {
  it("stores the buyer's credential with its public key, counter and transports", async () => {
    const authenticator = await registered();

    expect(await db.select().from(buyerPasskeys)).toEqual([
      expect.objectContaining({
        buyerId,
        credentialId: authenticator.credentialId,
        publicKey: Buffer.from(authenticator.cosePublicKey).toString('base64url'),
        counter: 0,
        transports: ['internal'],
        lastUsedAt: null,
      }),
    ]);
  });

  it('keeps only the transports WebAuthn defines', async () => {
    const authenticator = new TestAuthenticator(ORIGIN);
    const { options, ticket } = await registrationOptions(deps(), buyerId);
    const response = authenticator.register(options);
    response.response.transports = ['usb', 'carrier-pigeon', 'hybrid'];

    await registerPasskey(deps(), { buyerId, response, ticket });

    const [row] = await db.select().from(buyerPasskeys);
    expect(row.transports).toEqual(['usb', 'hybrid']);
  });

  /** A refusal stores nothing. */
  async function refused(attempt: Promise<unknown>) {
    expect(await attempt).toEqual({ ok: false });
  }

  it('refuses a ticket that has expired', async () => {
    const authenticator = new TestAuthenticator(ORIGIN);
    const { options, ticket } = await registrationOptions(deps(), buyerId);
    const later = new Date(NOW.getTime() + 300_000);

    await refused(registerPasskey(deps(later), { buyerId, response: authenticator.register(options), ticket }));
    expect(await db.select().from(buyerPasskeys)).toEqual([]);
  });

  it('refuses a ticket issued to another buyer', async () => {
    const authenticator = new TestAuthenticator(ORIGIN);
    const { options, ticket } = await registrationOptions(deps(), await addBuyer('Sam'));

    await refused(registerPasskey(deps(), { buyerId, response: authenticator.register(options), ticket }));
    expect(await db.select().from(buyerPasskeys)).toEqual([]);
  });

  it('refuses a response to a challenge other than the one its ticket holds', async () => {
    const authenticator = new TestAuthenticator(ORIGIN);
    const first = await registrationOptions(deps(), buyerId);
    const second = await registrationOptions(deps(), buyerId);

    await refused(registerPasskey(deps(), { buyerId, response: authenticator.register(first.options), ticket: second.ticket }));
    expect(await db.select().from(buyerPasskeys)).toEqual([]);
  });

  it('refuses a response made for another site', async () => {
    const authenticator = new TestAuthenticator(ORIGIN);
    const { options, ticket } = await registrationOptions(deps(), buyerId);
    const response = authenticator.register(options, { origin: 'https://behest.example' });

    await refused(registerPasskey(deps(), { buyerId, response, ticket }));
    expect(await db.select().from(buyerPasskeys)).toEqual([]);
  });

  it.each([null, 'response', {}, { id: 'x', rawId: 'x', type: 'public-key', response: {} }])(
    'refuses %j as a registration',
    async (response) => {
      const { ticket } = await registrationOptions(deps(), buyerId);

      await refused(registerPasskey(deps(), { buyerId, response, ticket }));
      expect(await db.select().from(buyerPasskeys)).toEqual([]);
    },
  );

  it('refuses a credential that is already registered, to this buyer or another', async () => {
    const authenticator = await registered();
    const other = await addBuyer('Sam');

    for (const buyer of [buyerId, other]) {
      const { options, ticket } = await registrationOptions(deps(), buyer);
      await refused(registerPasskey(deps(), { buyerId: buyer, response: authenticator.register(options), ticket }));
    }
    expect(await db.select().from(buyerPasskeys)).toEqual([expect.objectContaining({ buyerId })]);
  });
});
