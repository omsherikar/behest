import { eq } from 'drizzle-orm';
import { connection, NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/disputes/[id]/evidence/route';
import { appDb, appJwks, appPaypal } from '@/lib/app-deps';
import type { Db } from '@/lib/db/client';
import { disputes, receipts } from '@/lib/db/schema';
import type { Narrative } from '@/lib/disputes/narrative';
import { PayPalApiError } from '@/lib/paypal/http';
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
  const headers = new Headers({ 'content-type': 'application/json' });
  if (persona) headers.set('cookie', `${SESSION_COOKIE}=${await sessionCookie(persona)}`);
  return new NextRequest(`http://localhost/api/disputes/${id}/evidence`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function submit(body: unknown, options: { id?: string; persona?: Persona | null } = {}) {
  const id = options.id ?? disputeId;
  const response = await POST(await request(id, body, options), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
}

async function disputeRow(id = disputeId) {
  const [row] = await db.select().from(disputes).where(eq(disputes.id, id));
  return row;
}

const error = (message: string) => ({ error: { message } });

// The first createTestDb() in a file migrates the template database, which is slow on a busy machine.
beforeAll(() => createTestDb(), 60_000);

beforeEach(async () => {
  vi.stubEnv('SESSION_SECRET', SECRET);
  vi.stubEnv('APP_URL', APP_URL);
  ({ db, paypal, disputeId, purchaseId } = await chargedDispute());
  vi.mocked(appDb).mockReturnValue(db);
  vi.mocked(appPaypal).mockReturnValue(paypal);
  vi.mocked(appJwks).mockResolvedValue(jwks);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('POST /api/disputes/[id]/evidence', () => {
  it("submits the reviewed narrative to PayPal with the receipt's id and verification URL, and stores it", async () => {
    const { status, body } = await submit(NARRATIVE);

    expect(status).toBe(200);
    expect(connection).toHaveBeenCalled();
    expect(body).toEqual({ narrative: NARRATIVE });
    const [receipt] = await db.select({ id: receipts.id }).from(receipts).where(eq(receipts.purchaseId, purchaseId));
    const [[paypalDisputeId, { notes }]] = paypal.callsTo('provideEvidence');
    expect(paypalDisputeId).toBe(PAYPAL_DISPUTE_ID);
    expect(notes).toContain('1. The buyer confirmed a mandate of up to $60.00 a month on spices. [mandate] [readback]');
    expect(notes).toContain(`Signed receipt: ${receipt.id}`);
    expect(notes).toContain('Verify it at: https://behest.test/api/receipts/verify');
    expect(await disputeRow()).toMatchObject({ narrative: NARRATIVE, submittedAt: expect.any(Date) });
  });

  it('refuses with 400 a narrative citing items the evidence pack does not hold, naming each such claim, and drops nothing', async () => {
    const edited: Narrative = {
      summary: NARRATIVE.summary,
      claims: [
        NARRATIVE.claims[0],
        { text: 'The parcel was delivered.', evidenceIds: ['tracking'] },
        { text: 'The buyer approved the order.', evidenceIds: ['approval', 'mandate', 'tracking'] },
      ],
    };

    expect(await submit(edited)).toEqual({
      status: 400,
      body: error(
        'Some claims cite evidence this dispute does not have: claim 2 cites tracking; claim 3 cites approval and tracking. ' +
          'Its evidence is mandate, readback, receipt, cart and purchase_log.',
      ),
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });

  it.each([
    ['a body that is not JSON', '{', 'Send the narrative as JSON.'],
    ['no summary', { claims: NARRATIVE.claims }, 'Send the narrative as a summary and a list of claims.'],
    ['an empty summary', { ...NARRATIVE, summary: '  ' }, 'Write a summary.'],
    ['claims that are not a list', { ...NARRATIVE, claims: 'all of them' }, 'Send the narrative as a summary and a list of claims.'],
    ['no claims', { ...NARRATIVE, claims: [] }, 'Write at least one claim.'],
    ['an empty claim', { ...NARRATIVE, claims: [{ text: '', evidenceIds: ['mandate'] }] }, 'Every claim needs its text.'],
    [
      'a claim citing nothing',
      { ...NARRATIVE, claims: [{ text: 'It was paid.', evidenceIds: [] }] },
      'Every claim must cite at least one evidence item.',
    ],
    [
      'a claim citing one item twice',
      { ...NARRATIVE, claims: [{ text: 'It was paid.', evidenceIds: ['receipt', 'receipt'] }] },
      'Cite each evidence item once in a claim.',
    ],
    [
      'a citation of no kind of evidence item',
      { ...NARRATIVE, claims: [{ text: 'It was paid.', evidenceIds: ['invoice'] }] },
      'Cite evidence items by their ids: mandate, readback, receipt, cart, decision, purchase_log, approval or tracking.',
    ],
    ['a field a narrative does not have', { ...NARRATIVE, submitted: true }, 'Send the narrative as a summary and a list of claims.'],
  ])('answers 400 to %s, submitting nothing', async (_, body, message) => {
    expect(await submit(body)).toEqual({ status: 400, body: error(message) });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });

  it('answers 400 to notes longer than PayPal takes, telling the operator to shorten them, and submits nothing', async () => {
    const { status, body } = await submit({ ...NARRATIVE, summary: 'a'.repeat(2_000) });

    expect(status).toBe(400);
    expect(body.error.message).toMatch(/^The evidence notes come to [\d,]+ characters, and PayPal takes at most 2,000\. Shorten/);
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });

  it('refuses a body over 64 KiB with 413, submitting nothing', async () => {
    expect(await submit({ ...NARRATIVE, padding: 'a'.repeat(64 * 1024) })).toEqual({
      status: 413,
      body: error('This request is too large.'),
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
  });

  it.each([
    ['an id no dispute has', () => crypto.randomUUID()],
    ['an id that is not a dispute id', () => 'not-a-dispute-id'],
  ])('answers 404 to %s', async (_, id) => {
    expect(await submit(NARRATIVE, { id: id() })).toEqual({ status: 404, body: error('There is no such dispute.') });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
  });

  it('answers 409 to a dispute not matched to a purchase, submitting nothing', async () => {
    await db.delete(disputes);
    const unmatched = await openDispute(db, null);

    expect(await submit(NARRATIVE, { id: unmatched })).toEqual({
      status: 409,
      body: error('This dispute is not matched to a purchase, so Behest has no evidence for it.'),
    });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow(unmatched)).toMatchObject({ narrative: null, submittedAt: null });
  });

  it('answers 409 to a second submission, sending nothing more', async () => {
    expect((await submit(NARRATIVE)).status).toBe(200);
    const first = await disputeRow();

    expect(await submit({ ...NARRATIVE, summary: 'Another summary.' })).toEqual({
      status: 409,
      body: error('Evidence for this dispute was already submitted.'),
    });
    expect(paypal.callsTo('provideEvidence')).toHaveLength(1);
    expect(await disputeRow()).toMatchObject({ narrative: NARRATIVE, submittedAt: first.submittedAt });
  });

  it.each([
    [
      'an inquiry, which takes a message instead',
      paypalDispute({ stage: 'INQUIRY', actions: INQUIRY_ACTIONS }),
      'PayPal takes evidence once this inquiry becomes a claim. Until then, send the buyer your answer as a message.',
    ],
    [
      'a dispute PayPal is reviewing',
      paypalDispute({ status: 'UNDER_REVIEW', actions: [] }),
      'PayPal is reviewing this dispute and takes no answer from Behest right now.',
    ],
    [
      'a closed dispute',
      paypalDispute({ status: 'RESOLVED', actions: [] }),
      'PayPal has closed this dispute, so it takes no answer from Behest.',
    ],
  ])('answers 422 in plain words to %s, submitting nothing and storing what PayPal allows', async (_, live, message) => {
    paypal.disputes = [live];

    expect(await submit(NARRATIVE)).toEqual({ status: 422, body: error(message) });
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ stage: live.stage, actions: live.actions, narrative: null, submittedAt: null });
  });

  it("answers 502 without PayPal's details when the dispute cannot be checked at PayPal, submitting nothing", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(503, `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}`, '{"name":"SERVICE_UNAVAILABLE","debug_id":"f00dfeed"}');
    vi.spyOn(paypal, 'getDispute').mockRejectedValueOnce(answer);

    const response = await POST(await request(disputeId, NARRATIVE), { params: Promise.resolve({ id: disputeId }) });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual(error('Could not check the dispute at PayPal. Try again.'));
    expect(text).not.toMatch(/SERVICE_UNAVAILABLE|f00dfeed/);
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not return the dispute:', answer);
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });

  it("answers 502 without PayPal's details when PayPal fails, logging the cause and leaving the dispute to submit again", async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    paypal.failNext('provideEvidence', 'network');

    expect(await submit(NARRATIVE)).toEqual({
      status: 502,
      body: error('PayPal did not take the evidence. Submit it again to retry.'),
    });
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not take the evidence:', expect.any(TypeError));
    expect((await disputeRow()).submittedAt).toBeNull();

    expect((await submit(NARRATIVE)).status).toBe(200);
    expect(paypal.callsTo('provideEvidence')).toHaveLength(2);
  });

  it.each([
    [422, 'PayPal refused the evidence. Check the dispute at PayPal before trying again.'],
    [400, 'PayPal refused the evidence. Check the dispute at PayPal before trying again.'],
    [503, 'PayPal did not take the evidence. Submit it again to retry.'],
  ])('answers 502 to a PayPal %i with a fixed message and none of what PayPal sent', async (status, message) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const answer = new PayPalApiError(
      status,
      `/v1/customer/disputes/${PAYPAL_DISPUTE_ID}/provide-evidence`,
      '{"name":"UNPROCESSABLE_ENTITY","details":[{"issue":"CANNOT_PROVIDE_EVIDENCE"}],"debug_id":"f00dfeed"}',
    );
    vi.spyOn(paypal, 'provideEvidence').mockRejectedValueOnce(answer);

    const response = await POST(await request(disputeId, NARRATIVE), { params: Promise.resolve({ id: disputeId }) });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toEqual(error(message));
    expect(text).not.toMatch(/UNPROCESSABLE|CANNOT_PROVIDE|f00dfeed|provide-evidence/);
    expect(logged).toHaveBeenCalledWith('[disputes] PayPal did not take the evidence:', answer);
    expect((await disputeRow()).submittedAt).toBeNull();
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

    await expect(submit(NARRATIVE)).rejects.toThrow(failure);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });

  it.each([
    [null, 401],
    ['buyer', 403],
    ['seller', 403],
  ] as const)('answers a request with persona %s with %i, submitting nothing', async (persona, status) => {
    expect((await submit(NARRATIVE, { persona })).status).toBe(status);
    expect(paypal.callsTo('provideEvidence')).toEqual([]);
    expect(await disputeRow()).toMatchObject({ narrative: null, submittedAt: null });
  });
});
