import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedCall } from '@/tests/helpers/fake-fetch';
import { apiCalls, stubFetch } from '@/tests/helpers/paypal-fetch';
import disputeFixture from '@/tests/fixtures/paypal/dispute.json';
import disputeList from '@/tests/fixtures/paypal/dispute-list.json';
import resolvedFixture from '@/tests/fixtures/paypal/dispute-resolved.json';
import { PayPalApiError, resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { getDispute, listDisputes, provideEvidence } from '@/lib/paypal/disputes';

const DISPUTES = '/v1/customer/disputes';
const DISPUTE_ID = 'PP-R-QXT-10071254';
const DISPUTE_PATH = `${DISPUTES}/${DISPUTE_ID}`;
const EVIDENCE_PATH = `${DISPUTE_PATH}/provide-evidence`;
const CAPTURE_ID = '3KX75190LV2280416';
const BUYER_NOTES = 'My agent bought a 12 oz bag of whole bean coffee on November 3 and nothing has arrived.';

/** The JSON-only shape of a fixture dispute, so tests can replace any field. */
type Dispute = Record<string, unknown>;
const dispute: Dispute = disputeFixture;
/** A dispute PayPal resolved in Behest's favour. */
const resolvedDispute: Dispute = resolvedFixture;
const [listed, resolved] = disputeList.items;

const nextLink = (href: string) => ({ href, rel: 'next', method: 'GET' });

/** The dispute PayPal returns, with `fields` replaced. */
const disputeWith = (fields: Dispute): Dispute => ({ ...dispute, ...fields });

/** The parts of a recorded multipart request. */
function formOf(call: RecordedCall): Promise<FormData> {
  return new Response(call.body, { headers: { 'content-type': call.headers['content-type'] } }).formData();
}

/** The `input` part of a recorded evidence submission: its content type and its JSON. */
async function inputPartOf(call: RecordedCall): Promise<{ type: string; json: unknown }> {
  const input = (await formOf(call)).get('input');
  if (!(input instanceof Blob)) throw new Error('the request has no input part holding JSON');
  return { type: input.type, json: JSON.parse(await input.text()) };
}

beforeEach(() => {
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  resetPaypalTokenCacheForTests();
  setPaypalRetrySleepForTests(async () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('listDisputes', () => {
  it('reads the disputes with one GET of the largest page', async () => {
    const calls = stubFetch([{ method: 'GET', path: DISPUTES, body: disputeList }]);

    await listDisputes();

    const [get] = apiCalls(calls);
    expect(get.method).toBe('GET');
    expect(get.url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50');
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('summarizes each dispute in integer cents, with no capture id when the list names no transaction', async () => {
    stubFetch([{ method: 'GET', path: DISPUTES, body: disputeList }]);

    expect(await listDisputes()).toEqual([
      {
        id: 'PP-R-QXT-10071254',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        amountCents: 1875,
        captureId: null,
        createTime: '2026-11-04T16:22:41.000Z',
      },
      {
        id: 'PP-R-HBN-10070833',
        status: 'RESOLVED',
        reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
        amountCents: 6400,
        captureId: null,
        createTime: '2026-11-02T09:05:13.000Z',
      },
    ]);
  });

  it('reads the capture id of a listed dispute that names its transaction', async () => {
    const withTransaction = { ...listed, disputed_transactions: [{ seller_transaction_id: CAPTURE_ID }] };
    stubFetch([{ method: 'GET', path: DISPUTES, body: { ...disputeList, items: [withTransaction] } }]);

    const [summary] = await listDisputes();

    expect(summary.captureId).toBe(CAPTURE_ID);
  });

  it('follows the next link until the last page', async () => {
    const nextHref = 'https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&next_page_token=c2VjMm5kLXBhZ2U%3D';
    const calls = stubFetch([
      { method: 'GET', path: DISPUTES, once: true, body: { items: [listed], links: [nextLink(nextHref)] } },
      { method: 'GET', path: DISPUTES, once: true, body: { items: [resolved], links: [] } },
    ]);

    const disputes = await listDisputes();

    expect(disputes.map((d) => d.id)).toEqual(['PP-R-QXT-10071254', 'PP-R-HBN-10070833']);
    expect(apiCalls(calls).map((c) => c.url)).toEqual([
      'https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50',
      nextHref,
    ]);
  });

  it('reads up to 100 pages', async () => {
    const pages = Array.from({ length: 100 }, (_, i) => ({
      method: 'GET',
      path: DISPUTES,
      once: true,
      body: { items: [], links: i < 99 ? [nextLink(`https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&next_page_token=p${i + 1}`)] : [] },
    }));
    const calls = stubFetch(pages);

    expect(await listDisputes()).toEqual([]);
    expect(apiCalls(calls)).toHaveLength(100);
  });

  it('fails, naming the cap, rather than read a 101st page', async () => {
    const endless = Array.from({ length: 101 }, (_, i) => ({
      method: 'GET',
      path: DISPUTES,
      once: true,
      body: { items: [listed], links: [nextLink(`https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50&next_page_token=p${i + 1}`)] },
    }));
    const calls = stubFetch(endless);

    await expect(listDisputes()).rejects.toThrow(/100 pages/);
    expect(apiCalls(calls)).toHaveLength(100);
  });

  it('stops when the next link leads back to a page already read', async () => {
    const selfHref = 'https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50';
    const calls = stubFetch([{ method: 'GET', path: DISPUTES, body: { items: [listed], links: [nextLink(selfHref)] } }]);

    expect(await listDisputes()).toHaveLength(1);
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('returns no disputes when PayPal lists none', async () => {
    stubFetch([{ method: 'GET', path: DISPUTES, body: { links: [] } }]);

    expect(await listDisputes()).toEqual([]);
  });

  it('fails, naming the dispute, when a listed dispute is not in USD', async () => {
    const inEuros = { ...resolved, dispute_amount: { currency_code: 'EUR', value: '64.00' } };
    stubFetch([{ method: 'GET', path: DISPUTES, body: { items: [listed, inEuros] } }]);

    await expect(listDisputes()).rejects.toThrow(/PP-R-HBN-10070833.*EUR/);
  });
});

describe('getDispute', () => {
  it('reads the dispute with one GET by id', async () => {
    const calls = stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: dispute }]);

    await getDispute(DISPUTE_ID);

    const [get] = apiCalls(calls);
    expect(get.method).toBe('GET');
    expect(get.url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-QXT-10071254');
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it("maps the dispute with its capture id and the buyer's notes", async () => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: dispute }]);

    expect(await getDispute(DISPUTE_ID)).toEqual({
      id: DISPUTE_ID,
      status: 'WAITING_FOR_SELLER_RESPONSE',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      amountCents: 1875,
      captureId: CAPTURE_ID,
      createTime: '2026-11-04T16:22:41.000Z',
      buyerNotes: BUYER_NOTES,
      outcome: null,
      stage: 'INQUIRY',
      actions: ['provide_evidence', 'send_message'],
    });
  });

  it("maps a resolved dispute with PayPal's outcome code", async () => {
    const path = `${DISPUTES}/PP-R-HBN-10070833`;
    stubFetch([{ method: 'GET', path, body: resolvedDispute }]);

    expect(await getDispute('PP-R-HBN-10070833')).toEqual({
      id: 'PP-R-HBN-10070833',
      status: 'RESOLVED',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      amountCents: 6400,
      captureId: '9GT52816HX4471063',
      createTime: '2026-11-02T09:05:13.000Z',
      buyerNotes: 'The spice gift box was missing two of the jars the listing showed.',
      outcome: 'RESOLVED_SELLER_FAVOUR',
      stage: 'CHARGEBACK',
      actions: [],
    });
  });

  it('reads the stage and what PayPal allows the seller now from its links, leaving out self', async () => {
    // As the sandbox read an inquiry waiting for Behest: no provide_evidence link until it is a claim.
    const links = ['self', 'accept_claim', 'send_message', 'escalate', 'make_offer'].map((rel) => ({
      href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/${DISPUTE_ID}/${rel}`,
      rel,
      method: rel === 'self' ? 'GET' : 'POST',
    }));
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ dispute_life_cycle_stage: 'INQUIRY', links }) }]);

    expect(await getDispute(DISPUTE_ID)).toMatchObject({
      stage: 'INQUIRY',
      actions: ['accept_claim', 'send_message', 'escalate', 'make_offer'],
    });
  });

  it('names each action once and skips links with no rel', async () => {
    const links = [{ rel: 'provide_evidence' }, { href: 'https://api-m.sandbox.paypal.com/x' }, { rel: '' }, { rel: 'provide_evidence' }];
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ links }) }]);

    expect((await getDispute(DISPUTE_ID)).actions).toEqual(['provide_evidence']);
  });

  it('reports no stage and no actions when PayPal sends neither', async () => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ dispute_life_cycle_stage: undefined, links: undefined }) }]);

    expect(await getDispute(DISPUTE_ID)).toMatchObject({ stage: null, actions: [] });
  });

  it('reads a buyer-favoured outcome the same way', async () => {
    const buyerWon = { ...dispute, status: 'RESOLVED', dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: { currency_code: 'USD', value: '18.75' } } };
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: buyerWon }]);

    expect((await getDispute(DISPUTE_ID)).outcome).toBe('RESOLVED_BUYER_FAVOUR');
  });

  it("takes the buyer's earliest message by time posted, whatever the order PayPal lists them in", async () => {
    const messages = [
      { posted_by: 'BUYER', time_posted: '2026-11-05T08:10:12.000Z', content: 'Still nothing at my door.' },
      { posted_by: 'SELLER', time_posted: '2026-11-04T16:20:00.000Z', content: 'Your order shipped on November 3.' },
      { posted_by: 'BUYER', time_posted: '2026-11-04T16:22:41Z', content: BUYER_NOTES },
      { posted_by: 'BUYER', time_posted: '2026-11-04T18:02:55.000Z', content: 'Any update?' },
    ];
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ messages }) }]);

    expect((await getDispute(DISPUTE_ID)).buyerNotes).toBe(BUYER_NOTES);
  });

  it('counts a buyer message with no time posted as the latest', async () => {
    const messages = [
      { posted_by: 'BUYER', content: 'A message PayPal sent with no time.' },
      { posted_by: 'BUYER', time_posted: '2026-11-05T08:10:12.000Z', content: BUYER_NOTES },
    ];
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ messages }) }]);

    expect((await getDispute(DISPUTE_ID)).buyerNotes).toBe(BUYER_NOTES);
  });

  it('skips buyer messages with no text', async () => {
    const messages = [
      { posted_by: 'SELLER', time_posted: '2026-11-04T16:20:00.000Z', content: 'Your order shipped on November 3.' },
      { posted_by: 'BUYER', time_posted: '2026-11-04T16:21:30.000Z', content: '' },
      { posted_by: 'BUYER', time_posted: '2026-11-04T16:22:41.000Z', content: BUYER_NOTES },
      { posted_by: 'BUYER', time_posted: '2026-11-05T08:10:12.000Z', content: 'Still nothing at my door.' },
    ];
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ messages }) }]);

    expect((await getDispute(DISPUTE_ID)).buyerNotes).toBe(BUYER_NOTES);
  });

  it.each([
    { name: 'no messages', messages: undefined },
    { name: 'only messages from the seller and PayPal', messages: [{ posted_by: 'SELLER', content: 'Tracking: 9400 1118 9922 3847 5521 09' }, { posted_by: 'ARBITER', content: 'We are reviewing this case.' }] },
    { name: 'an empty buyer message', messages: [{ posted_by: 'BUYER', content: '' }] },
  ])('reports no buyer notes when the dispute has $name', async ({ messages }) => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ messages }) }]);

    expect((await getDispute(DISPUTE_ID)).buyerNotes).toBeNull();
  });

  it('reports no capture id when the dispute names no transaction', async () => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ disputed_transactions: undefined }) }]);

    expect((await getDispute(DISPUTE_ID)).captureId).toBeNull();
  });

  it('encodes the dispute id, so it stays one segment of the path', async () => {
    const calls = stubFetch([{ method: 'GET', path: `${DISPUTES}/AB%2FCD%3Fx%3D1`, body: dispute }]);

    await getDispute('AB/CD?x=1');

    const [get] = apiCalls(calls);
    expect(get.url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes/AB%2FCD%3Fx%3D1');
  });

  it.each([
    { name: 'in another currency', amount: { currency_code: 'GBP', value: '18.75' } },
    { name: 'with no amount', amount: undefined },
    { name: 'with an amount value that is not whole cents', amount: { currency_code: 'USD', value: '18.755' } },
  ])('fails, naming the dispute, when its amount is $name', async ({ amount }) => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ dispute_amount: amount }) }]);

    await expect(getDispute(DISPUTE_ID)).rejects.toThrow(DISPUTE_ID);
  });

  it.each(['status', 'reason', 'create_time'])('fails, naming the dispute, when it has no %s', async (field) => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ [field]: undefined }) }]);

    await expect(getDispute(DISPUTE_ID)).rejects.toThrow(DISPUTE_ID);
  });

  it('fails when the dispute has no id', async () => {
    stubFetch([{ method: 'GET', path: DISPUTE_PATH, body: disputeWith({ dispute_id: undefined }) }]);

    await expect(getDispute(DISPUTE_ID)).rejects.toThrow(/no dispute id/);
  });
});

describe('provideEvidence', () => {
  const notes = 'Signed mandate m_41c2 allowed this purchase. Receipt rcpt_7f3a and tracking 9400 1118 9922 3847 5521 09 are attached to the case.';

  it('posts the notes as OTHER evidence in the JSON input part of a multipart request', async () => {
    const calls = stubFetch([{ method: 'POST', path: EVIDENCE_PATH, body: { links: [] } }]);

    await provideEvidence(DISPUTE_ID, { notes });

    const [post] = apiCalls(calls);
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-R-QXT-10071254/provide-evidence');
    expect(post.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(await inputPartOf(post)).toEqual({
      type: 'application/json',
      json: { evidences: [{ evidence_type: 'OTHER', notes }] },
    });
    expect([...(await formOf(post)).keys()]).toEqual(['input']);
  });

  it('keys the submission on the dispute id', async () => {
    const calls = stubFetch([{ method: 'POST', path: EVIDENCE_PATH, body: { links: [] } }]);

    await provideEvidence(DISPUTE_ID, { notes });

    const [post] = apiCalls(calls);
    expect(post.headers['paypal-request-id']).toBe('PP-R-QXT-10071254:evidence');
  });

  it('resolves with nothing once PayPal accepts the evidence', async () => {
    stubFetch([{ method: 'POST', path: EVIDENCE_PATH, body: { links: [] } }]);

    await expect(provideEvidence(DISPUTE_ID, { notes })).resolves.toBeUndefined();
  });

  it('sends the same evidence under the same request id when PayPal is briefly unavailable', async () => {
    const calls = stubFetch([
      { method: 'POST', path: EVIDENCE_PATH, status: 503, once: true, body: { name: 'SERVICE_UNAVAILABLE' } },
      { method: 'POST', path: EVIDENCE_PATH, body: { links: [] } },
    ]);

    await provideEvidence(DISPUTE_ID, { notes });

    const posts = apiCalls(calls);
    expect(posts.map((c) => c.headers['paypal-request-id'])).toEqual(['PP-R-QXT-10071254:evidence', 'PP-R-QXT-10071254:evidence']);
    expect(await inputPartOf(posts[1])).toEqual(await inputPartOf(posts[0]));
  });

  it('encodes the dispute id, so it stays one segment of the path', async () => {
    const calls = stubFetch([{ method: 'POST', path: `${DISPUTES}/AB%2FCD%3Fx%3D1/provide-evidence`, body: { links: [] } }]);

    await provideEvidence('AB/CD?x=1', { notes });

    const [post] = apiCalls(calls);
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes/AB%2FCD%3Fx%3D1/provide-evidence');
  });

  it('rethrows a PayPal error untouched', async () => {
    const body = {
      name: 'VALIDATION_ERROR',
      message: 'Invalid request - see details',
      details: [{ field: 'evidences[0].notes', location: 'body', issue: 'Value is too long' }],
      debug_id: '9a1f04c6e2b35',
    };
    stubFetch([{ method: 'POST', path: EVIDENCE_PATH, status: 400, body }]);

    const error = await provideEvidence(DISPUTE_ID, { notes }).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 400, body: JSON.stringify(body) });
  });
});
