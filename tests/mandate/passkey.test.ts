import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/lib/db/client';
import { buyerPasskeys, buyers, mandates } from '@/lib/db/schema';
import type { MandatePolicy } from '@/lib/domain/policy';
import { confirmMandate, MandateConfirmError } from '@/lib/mandate/confirm';
import { mandateChallenge } from '@/lib/mandate/challenge';
import { type PasskeySignature, signingOptions, verifyMandateAssertion, verifyMandatePasskey } from '@/lib/mandate/passkey';
import { renderReadback } from '@/lib/mandate/readback';
import { registerPasskey, registrationOptions } from '@/lib/passkeys/register';
import { readTicket } from '@/lib/passkeys/ticket';
import { canonicalJson, hashOf, sha256Hex } from '@/lib/receipts/canonical';
import { generateSigningKey, loadSigningKey } from '@/lib/receipts/keys';
import { createSigner } from '@/lib/receipts/sign';
import { TestAuthenticator } from '@/tests/helpers/authenticator';
import { demoPolicy } from '@/tests/helpers/fixtures';
import { createTestDb } from '@/tests/helpers/test-db';

const ORIGIN = 'https://behest.test';
const NOW = new Date('2026-11-06T10:00:00.000Z');
const NOW_SECONDS = NOW.getTime() / 1000;
const TEXT = '$60 a month on groceries and spices, ask me above $25, never electronics';
const wider: MandatePolicy = { ...demoPolicy, budget: { amountCents: 600_000, period: 'month' }, perPurchaseMaxCents: 600_000 };

const signer = createSigner(await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem }));

let db: Db;
let buyerId: string;
const deps = (now = NOW) => ({ db, origin: ORIGIN, now: () => now });

async function addBuyer(name: string): Promise<string> {
  const [buyer] = await db.insert(buyers).values({ name }).returning();
  return buyer.id;
}

/** A software passkey registered to `buyer`. */
async function registered(buyer = buyerId): Promise<TestAuthenticator> {
  const authenticator = new TestAuthenticator(ORIGIN);
  const { options, ticket } = await registrationOptions(deps(), buyer);
  await registerPasskey(deps(), { buyerId: buyer, response: authenticator.register(options), ticket });
  return authenticator;
}

/** Signing options for `policy`, which must succeed. */
async function signing(policy: MandatePolicy = demoPolicy) {
  const result = await signingOptions(deps(), { buyerId, policy });
  if (!result.ok) throw new Error('expected signing options');
  return result;
}

/** The buyer's passkey-confirmed mandate row: registered, signed and confirmed through each step. */
async function passkeyMandate({ userVerified = true }: { userVerified?: boolean } = {}) {
  const authenticator = await registered();
  const { options, ticket } = await signing();
  const assertion = authenticator.assert(options, { userVerified });
  const verified = await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket });
  if (!verified.ok) throw new Error('expected the assertion to verify');
  const { mandateId } = await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: verified.signature });
  const [row] = await db.select().from(mandates).where(eq(mandates.id, mandateId));
  return { row, authenticator };
}

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 30_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', 'test-session-secret-at-least-32-characters');
  db = await createTestDb();
  buyerId = await addBuyer('Priya');
});

afterEach(() => vi.unstubAllEnvs());

describe('mandateChallenge', () => {
  const fields = { policyHash: 'a'.repeat(64), readbackHash: 'b'.repeat(64), nonce: 'bm9uY2U', exp: NOW_SECONDS + 300 };

  it('is the SHA-256 of the canonical JSON of the hashes, nonce and expiry, base64url', () => {
    const digest = createHash('sha256').update(canonicalJson(fields)).digest('base64url');
    expect(mandateChallenge(fields)).toBe(digest);
  });

  it.each([
    ['policy hash', { policyHash: 'c'.repeat(64) }],
    ['readback hash', { readbackHash: 'c'.repeat(64) }],
    ['nonce', { nonce: 'b3RoZXI' }],
    ['expiry', { exp: fields.exp + 1 }],
  ])('changes with the %s', (_, change) => {
    expect(mandateChallenge({ ...fields, ...change })).not.toBe(mandateChallenge(fields));
  });
});

describe('signingOptions', () => {
  it('says the buyer has no passkey to sign with yet', async () => {
    expect(await signingOptions(deps(), { buyerId, policy: demoPolicy })).toEqual({ ok: false, reason: 'no_passkey' });
  });

  it("asks the buyer's own passkeys to sign a challenge that commits to the mandate's hashes", async () => {
    const own = await registered();
    await registered(await addBuyer('Sam'));

    const { options, ticket } = await signing();

    const claims = readTicket(ticket, 'mandate_sign', NOW);
    expect(claims).toEqual({ kind: 'mandate_sign', buyer: sha256Hex(buyerId), nonce: expect.any(String), exp: NOW_SECONDS + 300 });
    const challenge = mandateChallenge({
      policyHash: hashOf(demoPolicy),
      readbackHash: hashOf(renderReadback(demoPolicy)),
      nonce: claims!.nonce,
      exp: claims!.exp,
    });
    expect(options).toEqual({
      challenge,
      rpId: 'behest.test',
      timeout: 300_000,
      userVerification: 'preferred',
      allowCredentials: [{ id: own.credentialId, type: 'public-key', transports: ['internal'] }],
    });
  });

  it('issues a new nonce, and so a new challenge, each time', async () => {
    await registered();
    const first = await signing();
    const second = await signing();
    expect(second.options.challenge).not.toBe(first.options.challenge);
  });

  it('refuses a policy that is not valid, as confirming it would', async () => {
    await registered();
    await expect(signingOptions(deps(), { buyerId, policy: { ...demoPolicy, currency: 'EUR' } as unknown as MandatePolicy })).rejects.toMatchObject({
      code: 'invalid_policy',
    });
  });
});

describe('verifyMandateAssertion', () => {
  it('accepts the assertion over the challenge for this policy, naming the passkey that signed', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const assertion = authenticator.assert(options);

    const verified = await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket });

    const [passkey] = await db.select().from(buyerPasskeys);
    const claims = readTicket(ticket, 'mandate_sign', NOW)!;
    expect(verified).toEqual({
      ok: true,
      signature: {
        passkeyId: passkey.id,
        counter: 1,
        passkey: { credentialId: authenticator.credentialId, publicKey: passkey.publicKey, alg: -7 },
        assertion: {
          credentialId: authenticator.credentialId,
          authenticatorData: assertion.response.authenticatorData,
          clientDataJSON: assertion.response.clientDataJSON,
          signature: assertion.response.signature,
          challenge: options.challenge,
          nonce: claims.nonce,
          exp: claims.exp,
          origin: ORIGIN,
          rpID: 'behest.test',
        },
      },
    });
  });

  it('accepts an assertion made with the user present but not verified, as the options only prefer verification', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const assertion = authenticator.assert(options, { userVerified: false });

    expect(await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket })).toMatchObject({ ok: true });
  });

  it('refuses the assertion for a policy other than the one it signed', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();

    expect(
      await verifyMandateAssertion(deps(), { buyerId, policy: wider, assertion: authenticator.assert(options), ticket }),
    ).toEqual({ ok: false });
  });

  it('refuses a ticket once it has expired', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const assertion = authenticator.assert(options);

    const later = new Date(NOW.getTime() + 300_000);
    expect(await verifyMandateAssertion(deps(later), { buyerId, policy: demoPolicy, assertion, ticket })).toEqual({ ok: false });
  });

  it("refuses another buyer's passkey", async () => {
    const other = await addBuyer('Sam');
    const theirs = await registered(other);
    await registered();
    const { options, ticket } = await signing();

    expect(
      await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion: theirs.assert(options), ticket }),
    ).toEqual({ ok: false });
  });

  it("refuses a ticket issued to another buyer", async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();

    expect(
      await verifyMandateAssertion(deps(), { buyerId: await addBuyer('Sam'), policy: demoPolicy, assertion: authenticator.assert(options), ticket }),
    ).toEqual({ ok: false });
  });

  it('refuses a counter that has gone backwards', async () => {
    const authenticator = await registered();
    await db.update(buyerPasskeys).set({ counter: 5 });
    const { options, ticket } = await signing();

    expect(
      await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion: authenticator.assert(options, { counter: 3 }), ticket }),
    ).toEqual({ ok: false });
  });

  it('refuses an assertion made for another site', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const assertion = authenticator.assert(options, { origin: 'https://behest.example' });

    expect(await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket })).toEqual({ ok: false });
  });

  it('refuses an assertion whose signature was changed', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const assertion = authenticator.assert(options);
    const forged = authenticator.assert({ ...options, challenge: 'b3RoZXI' });
    assertion.response.signature = forged.response.signature;

    expect(await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket })).toEqual({ ok: false });
  });

  it.each([null, 'assertion', {}, { id: 'unknown', rawId: 'unknown', type: 'public-key', response: {} }])(
    'refuses %j as an assertion',
    async (assertion) => {
      await registered();
      const { ticket } = await signing();
      expect(await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket })).toEqual({ ok: false });
    },
  );
});

describe('verifyMandatePasskey', () => {
  /** `jws` signed again by Behest's key with its claims changed, so only the claims differ. */
  async function resigned(jws: string, change: (claims: Record<string, unknown>) => void): Promise<string> {
    const claims = JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
    change(claims);
    return signer.sign(claims, 'behest-mandate+jws');
  }

  it("verifies a stored mandate's passkey signature at the origin and RP id stored with it, with the key in its JWS", async () => {
    const { row, authenticator } = await passkeyMandate();

    expect(row.buyerAssertion).toMatchObject({ origin: ORIGIN, rpID: 'behest.test' });
    expect(await verifyMandatePasskey(row)).toEqual({
      verified: true,
      credentialId: authenticator.credentialId,
      origin: ORIGIN,
      rpID: 'behest.test',
      userVerified: true,
    });
  });

  it('reports a signature made with the user present but not verified as just that', async () => {
    const { row } = await passkeyMandate({ userVerified: false });

    expect(await verifyMandatePasskey(row)).toMatchObject({ verified: true, userVerified: false });
  });

  it('says a mandate confirmed by session alone carries no passkey signature', async () => {
    const { mandateId } = await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy });
    const [row] = await db.select().from(mandates).where(eq(mandates.id, mandateId));

    expect(await verifyMandatePasskey(row)).toEqual({ verified: false, reason: 'session' });
  });

  it('fails a stored policy or readback that no longer hashes to what was signed', async () => {
    const { row } = await passkeyMandate();

    expect(await verifyMandatePasskey({ ...row, policy: wider })).toEqual({ verified: false, reason: 'hash_mismatch' });
    expect(await verifyMandatePasskey({ ...row, readback: ['Spend anything.'] })).toEqual({ verified: false, reason: 'hash_mismatch' });
    expect(await verifyMandatePasskey({ ...row, policyHash: hashOf(wider) })).toEqual({ verified: false, reason: 'hash_mismatch' });
  });

  it('counts a signature only for a mandate confirmed inside its signing window, so an old one cannot vouch for a later mandate', async () => {
    const { row } = await passkeyMandate();
    const { exp } = row.buyerAssertion!;
    const confirmedAt = async (ms: number) =>
      verifyMandatePasskey({
        ...row,
        jws: await resigned(row.jws, (claims) => {
          claims.confirmedAt = new Date(ms).toISOString();
        }),
      });

    expect(await confirmedAt((exp - 300) * 1000)).toMatchObject({ verified: true });
    expect(await confirmedAt(exp * 1000 - 1)).toMatchObject({ verified: true });
    const outside = { verified: false, reason: 'outside_window' };
    expect(await confirmedAt((exp - 300) * 1000 - 1)).toEqual(outside);
    expect(await confirmedAt(exp * 1000)).toEqual(outside);
    expect(await confirmedAt(exp * 1000 + 24 * 60 * 60 * 1000)).toEqual(outside);
  });

  it('says the origin is unknown, never that the signature fails, for an assertion stored without its origin or RP id', async () => {
    const { row } = await passkeyMandate();
    const { origin, rpID, ...older } = row.buyerAssertion!;
    expect([origin, rpID]).toEqual([ORIGIN, 'behest.test']);

    const unknown = { verified: false, reason: 'origin_unknown' };
    expect(await verifyMandatePasskey({ ...row, buyerAssertion: older })).toEqual(unknown);
    expect(await verifyMandatePasskey({ ...row, buyerAssertion: { ...older, origin } })).toEqual(unknown);
    expect(await verifyMandatePasskey({ ...row, buyerAssertion: { ...older, rpID } })).toEqual(unknown);
  });

  it('fails an assertion whose fields, origin or RP id were changed', async () => {
    const { row } = await passkeyMandate();
    const assertion = row.buyerAssertion!;

    for (const changed of [
      { ...assertion, nonce: 'b3RoZXI' },
      // A second earlier, so the confirmation still falls in the window and only the challenge differs.
      { ...assertion, exp: assertion.exp - 1 },
      { ...assertion, signature: Buffer.from('not a signature').toString('base64url') },
      { ...assertion, credentialId: 'b3RoZXI' },
      { ...assertion, origin: 'https://behest.example' },
      { ...assertion, rpID: 'behest.example' },
    ]) {
      expect(await verifyMandatePasskey({ ...row, buyerAssertion: changed })).toEqual({ verified: false, reason: 'bad_signature' });
    }
  });

  it('fails a mandate whose JWS names a key other than the one that signed', async () => {
    const { row } = await passkeyMandate();
    const impostor = new TestAuthenticator(ORIGIN);
    const jws = await resigned(row.jws, (claims) => {
      (claims.passkey as { publicKey: string }).publicKey = Buffer.from(impostor.cosePublicKey).toString('base64url');
    });

    expect(await verifyMandatePasskey({ ...row, jws })).toEqual({ verified: false, reason: 'bad_signature' });
  });

  it('fails a mandate whose JWS or assertion cannot be read', async () => {
    const { row } = await passkeyMandate();

    expect(await verifyMandatePasskey({ ...row, jws: 'not-a-jws' })).toEqual({ verified: false, reason: 'malformed' });
    expect(await verifyMandatePasskey({ ...row, buyerAssertion: null })).toEqual({ verified: false, reason: 'malformed' });
  });
});

describe('PasskeySignature', () => {
  it('can be made only by verifyMandateAssertion, which the type system enforces', () => {
    const plain = {
      passkeyId: crypto.randomUUID(),
      counter: 1,
      passkey: { credentialId: 'Y3JlZA', publicKey: 'cGs', alg: -7 },
      assertion: { credentialId: 'Y3JlZA', authenticatorData: 'YQ', clientDataJSON: 'Yg', signature: 'Yw', challenge: 'ZA', nonce: 'ZQ', exp: 1 },
    };
    // @ts-expect-error A signature that did not come from verifyMandateAssertion is not a PasskeySignature.
    const signature: PasskeySignature = plain;
    expect(signature).toBe(plain);
  });
});

describe('confirmMandate with a passkey signature', () => {
  /** A verified passkey signature over the demo policy. */
  async function signed(authenticator: TestAuthenticator) {
    const { options, ticket } = await signing();
    const verified = await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion: authenticator.assert(options), ticket });
    if (!verified.ok) throw new Error('expected the assertion to verify');
    return verified.signature;
  }

  it('stores the mandate as confirmed by passkey, with the assertion, and signs a payload naming the passkey', async () => {
    const authenticator = await registered();
    const signature = await signed(authenticator);

    const { mandateId, jws } = await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: signature });

    const [row] = await db.select().from(mandates);
    expect(row).toMatchObject({ id: mandateId, confirmation: 'passkey', buyerAssertion: signature.assertion, jws });
    const payload = JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ confirmation: 'passkey', passkey: signature.passkey, policyHash: hashOf(demoPolicy) });
  });

  it("moves the passkey's counter to the one the assertion reported and records when it was used", async () => {
    const authenticator = await registered();
    const signature = await signed(authenticator);

    await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: signature });

    expect(await db.select().from(buyerPasskeys)).toEqual([expect.objectContaining({ counter: 1, lastUsedAt: NOW })]);
  });

  it('leaves a mandate confirmed by session without an assertion', async () => {
    await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy });

    expect(await db.select().from(mandates)).toEqual([expect.objectContaining({ confirmation: 'session', buyerAssertion: null })]);
  });

  it('refuses a signature that already confirmed a mandate, storing nothing more', async () => {
    const authenticator = await registered();
    const signature = await signed(authenticator);
    await confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: signature });

    // A higher counter, so only the reused nonce can refuse it.
    const replayed = { ...signature, counter: signature.counter + 1 };
    const attempt = confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: replayed });

    await expect(attempt).rejects.toMatchObject({ code: 'passkey' });
    expect(await db.select().from(mandates)).toEqual([expect.objectContaining({ status: 'active' })]);
  });

  it('lets an authenticator that keeps no counter confirm again with a new signature, but never with the same one', async () => {
    const authenticator = await registered();
    const once = async () => {
      const { options, ticket } = await signing();
      return { assertion: authenticator.assert(options, { counter: 0 }), ticket };
    };
    const confirmWith = async ({ assertion, ticket }: Awaited<ReturnType<typeof once>>) => {
      const verified = await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion, ticket });
      if (!verified.ok) throw new Error('expected the assertion to verify');
      return confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: verified.signature });
    };
    const first = await once();
    await confirmWith(first);

    // The counter stays at 0 and passes; the second confirm fails on the spent nonce alone.
    await expect(confirmWith(first)).rejects.toMatchObject({ code: 'passkey' });
    expect(await db.select().from(buyerPasskeys)).toEqual([expect.objectContaining({ counter: 0 })]);

    await confirmWith(await once());
    expect(await db.select({ status: mandates.status }).from(mandates)).toHaveLength(2);
  });

  it('refuses a signature once its window has closed, storing nothing', async () => {
    const authenticator = await registered();
    const signature = await signed(authenticator);
    const closed = new Date(signature.assertion.exp * 1000);

    const attempt = confirmMandate({ db, signer, now: () => closed }, { buyerId, text: TEXT, policy: demoPolicy, passkey: signature });

    await expect(attempt).rejects.toMatchObject({ code: 'passkey' });
    expect(await db.select().from(mandates)).toEqual([]);
  });

  it('refuses a signature when the passkey has signed something since, storing nothing', async () => {
    const authenticator = await registered();
    const signature = await signed(authenticator);
    await db.update(buyerPasskeys).set({ counter: signature.counter });

    const attempt = confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: demoPolicy, passkey: signature });

    await expect(attempt).rejects.toMatchObject({ code: 'passkey' });
    expect(await db.select().from(mandates)).toEqual([]);
  });

  it('refuses a signature whose challenge commits to another policy, storing nothing', async () => {
    const authenticator = await registered();
    const { options, ticket } = await signing();
    const verified = await verifyMandateAssertion(deps(), { buyerId, policy: demoPolicy, assertion: authenticator.assert(options), ticket });
    if (!verified.ok) throw new Error('expected the assertion to verify');

    const attempt = confirmMandate({ db, signer, now: () => NOW }, { buyerId, text: TEXT, policy: wider, passkey: verified.signature });

    await expect(attempt).rejects.toBeInstanceOf(MandateConfirmError);
    await expect(attempt).rejects.toMatchObject({ code: 'passkey' });
    expect(await db.select().from(mandates)).toEqual([]);
  });
});
