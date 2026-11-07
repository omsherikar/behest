import { eq } from 'drizzle-orm';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/disputes/[id]/message/route';
import { appDb, appJwks, appPaypal } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import type { Narrative } from '@/lib/disputes/narrative';
import { PayPalApiError } from '@/lib/paypal/http';
import { BUYER_MESSAGE_LIMIT, rateLimit } from '@/lib/ratelimit';
import { SESSION_COOKIE, sessionCookie, type Persona } from '@/lib/session';
import type { FakePaypal } from '@/tests/helpers/fake-paypal';
import { jwks } from '@/tests/helpers/purchase-deps';
import { chargedDispute, INQUIRY_ACTIONS, openDispute, PAYPAL_DISPUTE_ID, paypalDispute } from '@/tests/helpers/seed-dispute';
import { createTestDb } from '@/tests/helpers/test-db';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appDb: vi.fn(),
  appJwks: vi.fn(),
  appPaypal: vi.fn(),
}));
vi.mock('@/lib/ratelimit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ratelimit')>()),
  rateLimit: vi.fn(() => true),
}));

const SECRET = 'test-session-secret-at-least-32-characters';
const APP_URL = 'https://behest.test';

const NARRATIVE: Narrative = {
  summary: 'The buyer authorized this purchase in a signed mandate.',
  claims: [
    { text: 'The buyer confirmed a mandate of up to $60.00 a month on spices.', evidenceIds: ['mandate', 'readback'] },
    { text: 'Behest charged $18.75 for the cart its signed receipt covers.', evidenceIds: ['cart', 'receipt'] },
  ],
};

let db: Db;
let paypal: FakePaypal;
let disputeId: string;
let purchaseId: string;

async function request(id: string, body: unknown, { persona = 'operator' }: { persona?: Persona | null } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1, 203.0.113.7' });
  if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest(`http://localhost/api/disputes/${id}/message`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function send(body: unknown, options: { id?: string; persona?: Persona | null } = {}) {
  const id = options.id ?? disputeId;
  const response = await POST(await request(id, body, options), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

async function disputeRow(id = disputeId) {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, id));
  return row;
}

const error = (message: string) => ({ error: { message } });
const NOTHING_STORED = { narrative: null, messagedAt: null, submittedAt: null };

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', APP_URL);
  ({ db, paypal, disputeId, purchaseId } = await chargedDispute());
  // An inquiry waiting for Behest, as the sandbox read one: PayPal takes a message, not evidence.
  paypal.disputes = [paypalDispute({ stage: 'INQUIRY', actions: INQUIRY_ACTIONS })];
  vi.mocked(appDb).mockReturnValue(db);
  vi.mocked(appPaypal).mockReturnValue(paypal);
  vi.mocked(appJwks).mockResolvedValue(jwks);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/disputes/[id]/message', () => {
  it("sends the reviewed narrative to the buyer with the receipt's id and verification URL, and stores it with the time", async () => {
    const { status, body } = await send(NARRATIVE);

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    const row = await disputeRow();
    expect(body).toEqual({ narrative: NARRATIVE, messagedAt: row.messagedAt?.toISOString() });
    const [receipt] = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.purchaseId, purchaseId));
    const [[paypalDisputeId, message]] = paypal.callsTo('sendDisputeMessage');
    expect(paypalDisputeId).toBe(PAYPAL_DISPUTE_ID);
    expect(message).toContain('1. The buyer confirmed a mandate of up to $60.00 a month on spices. [mandate] [readback]');
    expect(message).toContain(`Signed receipt: ${receipt.id}`);
    expect(message).toContain('Verify it at: https://behest.test/api/receipts/verify');
    expect(row).toMatchObject({ narrative: NARRATIVE, messagedAt: expect.any(Date), submittedAt: null, stage: 'INQUIRY' });
  });

  it('refuses with 400 a narrative citing items the evidence pack does not hold, naming each such claim, and sends nothing', async () => {
    const edited: Narrative = {
      summary: NARRATIVE.summary,
      claims: [NARRATIVE.claims[0], { text: 'The parcel was delivered.', evidenceIds: ['tracking'] }],
    };

    expect(await send(edited)).toEqual({
      status: 400,
      body: error(
        'Some claims cite evidence this dispute does not have: claim 2 cites tracking. Its evidence is mandate, readback, receipt, cart and purchase_log.',
      ),
    });
    expect(paypal.callsTo('getDispute')).toEqual([]);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it.each([
    ['a body that is not JSON', '{', 'Send the narrative as JSON.'],
    ['no summary', { claims: NARRATIVE.claims }, 'Send the narrative as a summary and a list of claims.'],
    ['an empty summary', { ...NARRATIVE, summary: '  ' }, 'Write a summary.'],
    ['no claims', { ...NARRATIVE, claims: [] }, 'Write at least one claim.'],
    [
      'a claim citing nothing',
      { ...NARRATIVE, claims: [{ text: 'It was paid.', evidenceIds: [] }] },
      'Every claim must cite at least one evidence item.',
    ],
    ['a field a narrative does not have', { ...NARRATIVE, submitted: true }, 'Send the narrative as a summary and a list of claims.'],
  ])('answers 400 to %s, sending nothing', async (_, body, message) => {
    expect(await send(body)).toEqual({ status: 400, body: error(message) });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it('answers 400 to a message longer than PayPal takes, telling the operator to shorten it, and sends nothing', async () => {
    const { status, body } = await send({ ...NARRATIVE, summary: 'a'.repeat(2_000) });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/^The message comes to [\d,]+ characters, and PayPal takes at most 2,000\. Shorten/);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it('refuses a body over 64 KiB with 413, sending nothing', async () => {
    expect(await send({ ...NARRATIVE, padding: 'a'.repeat(64 * 1024) })).toEqual({
      status: 413,
      body: error('This request is too large.'),
    });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
  });

  it.each([
    ['an id no dispute has', () => crypto.randomUUID()],
    ['an id that is not a dispute id', () => 'not-a-dispute-id'],
  ])('answers 404 to %s', async (_, id) => {
    expect(await send(NARRATIVE, { id: id() })).toEqual({ status: 404, body: error('There is no such dispute.') });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
  });

  it('answers 409 to a dispute not matched to a purchase, sending nothing', async () => {
    await db.delete(disputes);
    const unmatched = await openDispute(db, null);

    expect(await send(NARRATIVE, { id: unmatched })).toEqual({
      status: 409,
      body: error('This dispute is not matched to a purchase, so Behest has no evidence for it.'),
    });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow(unmatched)).toMatchObject(NOTHING_STORED);
  });

  it('answers 409 to a dispute whose evidence was already submitted, sending nothing', async () => {
    const submittedAt = new Date('2026-11-07T15:00:00Z');
    await db.update(disputes).set({ narrative: NARRATIVE, submittedAt }).where(eq(disputes.id, disputeId));

    expect(await send({ ...NARRATIVE, summary: 'Another summary.' })).toEqual({
      status: 409,
      body: error('Evidence for this dispute was already submitted, so no message was sent.'),
    });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: NARRATIVE, submittedAt, messagedAt: null });
  });

  it.each([
    [
      'a claim, which takes evidence instead',
      paypalDispute({ actions: ['provide_evidence', 'accept_claim'] }),
      'PayPal takes evidence on this dispute now, not a message. Submit the evidence to PayPal instead.',
    ],
    [
      'a dispute PayPal is reviewing',
      paypalDispute({ status: 'UNDER_REVIEW', actions: [] }),
      'PayPal is reviewing this dispute and takes no answer from Behest right now.',
    ],
    ['a closed dispute', paypalDispute({ status: 'RESOLVED', actions: [] }), 'PayPal has closed this dispute, so it takes no answer from Behest.'],
  ])('answers 422 in plain words to %s, sending nothing and storing what PayPal allows', async (_, live, message) => {
    paypal.disputes = [live];

    expect(await send(NARRATIVE)).toEqual({ status: 422, body: error(message) });
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ stage: live.stage, actions: live.actions, ...NOTHING_STORED });
  });

  it("answers 502 without PayPal's details when the dispute cannot be checked at PayPal, sending nothing", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(503, `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}`, '{"name":"SERVICE_UNAVAILABLE","debug_id":"f00dfeed"}');
    vi.spyOn(paypal, 'getDispute').mockRejectedValueOnce(answer);

    const response = await POST(await request(disputeId, NARRATIVE), { params: Promise.resolve({ id: disputeId }) });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual(error('Could not check the dispute at PayPal. Try again.'));
    expect(text).not.toMatch(/SERVICE_UNAVAILABLE|f00dfeed/);
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not return the dispute:', answer);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it.each([
    [422, 'PayPal refused the message. Check the dispute at PayPal before trying again.'],
    [400, 'PayPal refused the message. Check the dispute at PayPal before trying again.'],
    [503, 'PayPal did not take the message. Send it again to retry.'],
  ])('answers 502 to a PayPal %i with a fixed message and none of what PayPal sent', async (status, message) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(
      status,
      `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}/send-message`,
      '{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE"}],"debug_id":"f00dfeed"}',
    );
    vi.spyOn(paypal, 'sendDisputeMessage').mockRejectedValueOnce(answer);

    const response = await POST(await request(disputeId, NARRATIVE), { params: Promise.resolve({ id: disputeId }) });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual(error(message));
    expect(text).not.toMatch(/UNPROCESSABLE|ACTION_NOT_ALLOWED|f00dfeed|send-message/);
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not take the message:', answer);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it('counts messages per address against the buyer message limit, and answers 429 past it', async () => {
    vi.mocked(rateLimit).mockReturnValueOnce(false);

    expect(await send(NARRATIVE)).toEqual({ status: 429, body: error('Too many messages at once. Try again in a minute.') });
    expect(rateLimit).toHaveBeenCalledWith('dispute_message:203.0.113.7:operator', BUYER_MESSAGE_LIMIT);
    expect(paypal.callsTo('getDispute')).toEqual([]);
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it.each([
    ['APP_URL', () => vi.stubEnv('APP_URL', ''), /APP_URL/],
    [
      'the PayPal credentials',
      () =>
        vi.mocked(appPaypal).mockImplementationOnce(() => {
          throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');
        }),
      /PAYPAL_CLIENT_ID/,
    ],
  ])('fails without %s, storing nothing', async (_, unset, failure) => {
    unset();

    await expect(send(NARRATIVE)).rejects.toThrow(failure);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });

  it.each([
    [null, 401],
    ['buyer', 403],
    ['seller', 403],
  ] as const)('answers a request with persona %s with %i, sending nothing', async (persona, status) => {
    expect((await send(NARRATIVE, { persona })).status).toBe(status);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(paypal.callsTo('sendDisputeMessage')).toEqual([]);
    expect(await disputeRow()).toMatchObject(NOTHING_STORED);
  });
});
