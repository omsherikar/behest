import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch } from '@/tests/helpers/fake-fetch';
import { apiCalls, oauth, stubFetch, stubFetchLosingFirstResponse } from '@/tests/helpers/paypal-fetch';
import payoutBatchPending from '@/tests/fixtures/paypal/payout-batch-pending.json';
import payoutBatchSuccess from '@/tests/fixtures/paypal/payout-batch-success.json';
import payoutCreated from '@/tests/fixtures/paypal/payout-created.json';
import duplicateSenderBatch from '@/tests/fixtures/paypal/payout-duplicate-sender-batch.json';
import { PayPalApiError, resetPaypalTokenCacheForTests, setPaypalRetrySleepForTests } from '@/lib/paypal/http';
import { PayoutAlreadyExists, createPayout, getPayoutBatch } from '@/lib/paypal/payouts';

const PAYOUTS = '/v1/payments/payouts';

const PURCHASE = '5d0c7a1e-3b84-4f2a-9e61-c8a24f7b3d90';
const SENDER_BATCH_ID = `${PURCHASE}:payout`;
const BATCH_ID = '7KQ2XWB9MNZ4E';

const payoutInput = {
  receiverEmail: 'payouts@northfork.example.com',
  amountCents: 1875,
  note: `Behest order ${PURCHASE}`,
  senderBatchId: SENDER_BATCH_ID,
};

/** The batch that the recorded duplicate error links, on its SENDER_BATCH_ID detail. */
const EXISTING_BATCH_ID = '3VMB5TF975CZS';
const [duplicateDetail] = duplicateSenderBatch.details;
const [existingBatchLink] = duplicateDetail.link;

/** PayPal's recorded duplicate error with the batch link placed as given; `undefined` leaves the detail with none. */
function duplicateWithLinks(detailLink: unknown, links: unknown[]) {
  return { ...duplicateSenderBatch, details: [{ ...duplicateDetail, link: detailLink }], links };
}

/** The paid batch with its one item's status replaced. */
function withItemStatus(status: string) {
  const [item] = payoutBatchSuccess.items;
  return { ...payoutBatchSuccess, items: [{ ...item, transaction_status: status }] };
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

describe('createPayout', () => {
  it('pays the seller in one batch, keyed on the sender batch id', async () => {
    const calls = stubFetch([{ method: 'POST', path: PAYOUTS, status: 201, body: payoutCreated }]);

    await createPayout(payoutInput);

    const [post] = apiCalls(calls);
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts');
    expect(post.headers['paypal-request-id']).toBe(SENDER_BATCH_ID);
    expect(JSON.parse(post.body ?? '')).toEqual({
      sender_batch_header: { sender_batch_id: SENDER_BATCH_ID, email_subject: 'You have a Behest payout' },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: '18.75', currency: 'USD' },
          receiver: 'payouts@northfork.example.com',
          note: `Behest order ${PURCHASE}`,
          sender_item_id: SENDER_BATCH_ID,
        },
      ],
    });
  });

  it('returns the payout batch id', async () => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 201, body: payoutCreated }]);

    expect(await createPayout(payoutInput)).toEqual({ payoutBatchId: BATCH_ID });
  });

  it('reports a payout repeated after a lost response as the existing batch, sent with the same PayPal-Request-Id and body', async () => {
    // The sandbox does not replay the first answer to a repeated request id. It refuses the repeat as
    // a duplicate sender batch, linking the batch the lost response would have named.
    const refused = duplicateWithLinks([{ ...existingBatchLink, href: `https://api.sandbox.paypal.com${PAYOUTS}/${BATCH_ID}` }], []);
    const { calls, lost } = stubFetchLosingFirstResponse(
      [
        { method: 'POST', path: PAYOUTS, status: 201, body: payoutCreated, once: true },
        { method: 'POST', path: PAYOUTS, status: 400, body: refused },
      ],
      PAYOUTS,
    );

    await expect(createPayout(payoutInput)).rejects.toBe(lost);
    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayoutAlreadyExists);
    expect(error).toMatchObject({ senderBatchId: SENDER_BATCH_ID, payoutBatchId: BATCH_ID });
    const posts = apiCalls(calls);
    expect(posts.map((c) => c.headers['paypal-request-id'])).toEqual([SENDER_BATCH_ID, SENDER_BATCH_ID]);
    expect(posts[1].body).toBe(posts[0].body);
  });

  it('reports a sender batch id PayPal already used as an existing payout, with the batch linked from its detail', async () => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 400, body: duplicateSenderBatch }]);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayoutAlreadyExists);
    expect(error).toMatchObject({ senderBatchId: SENDER_BATCH_ID, payoutBatchId: EXISTING_BATCH_ID });
    expect(error.message).toContain(SENDER_BATCH_ID);
    expect(error.cause).toBeInstanceOf(PayPalApiError);
    expect(error.cause).toMatchObject({ status: 400, body: JSON.stringify(duplicateSenderBatch) });
  });

  it.each([
    { name: 'a single link object on the detail', body: duplicateWithLinks(existingBatchLink, []) },
    { name: 'only a top-level link', body: duplicateWithLinks(undefined, [existingBatchLink]) },
  ])('reads the existing batch from $name', async ({ body }) => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 400, body }]);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayoutAlreadyExists);
    expect(error).toMatchObject({ payoutBatchId: EXISTING_BATCH_ID });
  });

  it('reports an existing payout with no batch id when PayPal links no batch in either place', async () => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 400, body: duplicateWithLinks(undefined, []) }]);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayoutAlreadyExists);
    expect(error).toMatchObject({ senderBatchId: SENDER_BATCH_ID, payoutBatchId: null });
  });

  it('ignores a batch link on a detail about another field', async () => {
    const otherDetail = { field: 'items[0].receiver', location: 'body', issue: 'Receiver is unconfirmed', link: [existingBatchLink] };
    const body = { ...duplicateWithLinks(undefined, []), details: [{ ...duplicateDetail, link: undefined }, otherDetail] };
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 400, body }]);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayoutAlreadyExists);
    expect(error).toMatchObject({ payoutBatchId: null });
  });

  it.each([
    {
      name: 'a validation error on the sender batch id',
      status: 400,
      body: {
        name: 'VALIDATION_ERROR',
        message: 'Invalid request - see details.',
        details: [{ field: 'sender_batch_header.sender_batch_id', location: 'body', issue: 'Length of sender_batch_id exceeds 256' }],
      },
    },
    {
      name: 'a business error about another field',
      status: 400,
      body: {
        name: 'USER_BUSINESS_ERROR',
        message: 'User business error.',
        details: [{ field: 'items[0].recipient_type', location: 'body', issue: 'Recipient type is not supported' }],
      },
    },
    {
      name: 'insufficient funds',
      status: 422,
      body: { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds. Please add funds and retry.' },
    },
    { name: 'a server error, even one naming the sender batch id', status: 500, body: duplicateSenderBatch },
  ])('rethrows $name untouched', async ({ status, body }) => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status, body }]);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status, body: JSON.stringify(body) });
  });

  it('rethrows a 400 whose body is not JSON, even if it names the sender batch id', async () => {
    const f = fakeFetch([oauth]);
    const html = '<html><body>400 USER_BUSINESS_ERROR SENDER_BATCH_ID already exists</body></html>';
    const stub: typeof fetch = async (input, init) =>
      new URL(String(input)).pathname === PAYOUTS ? new Response(html, { status: 400 }) : f.fetch(input, init);
    vi.stubGlobal('fetch', stub);

    const error = await createPayout(payoutInput).catch((e) => e);

    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error).toMatchObject({ status: 400, body: html });
  });

  it('fails, naming the sender batch, when PayPal answers with no payout batch id', async () => {
    stubFetch([{ method: 'POST', path: PAYOUTS, status: 201, body: { batch_header: { batch_status: 'PENDING' } } }]);

    await expect(createPayout(payoutInput)).rejects.toThrow(SENDER_BATCH_ID);
  });
});

describe('getPayoutBatch', () => {
  it('reads the batch with one GET', async () => {
    const calls = stubFetch([{ method: 'GET', path: `${PAYOUTS}/${BATCH_ID}`, body: payoutBatchSuccess }]);

    await getPayoutBatch(BATCH_ID);

    const [get] = apiCalls(calls);
    expect(get.method).toBe('GET');
    expect(get.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts/7KQ2XWB9MNZ4E');
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it.each([
    { name: 'a pending batch', body: payoutBatchPending, batchStatus: 'PENDING', itemStatus: 'PENDING' },
    { name: 'a paid batch', body: payoutBatchSuccess, batchStatus: 'SUCCESS', itemStatus: 'SUCCESS' },
    { name: 'a batch whose payment was returned', body: withItemStatus('RETURNED'), batchStatus: 'SUCCESS', itemStatus: 'RETURNED' },
  ])('reports the batch and item status of $name as PayPal sent them', async ({ body, batchStatus, itemStatus }) => {
    stubFetch([{ method: 'GET', path: `${PAYOUTS}/${BATCH_ID}`, body }]);

    expect(await getPayoutBatch(BATCH_ID)).toEqual({ batchStatus, itemStatus });
  });

  it.each([
    { name: 'an empty item list', body: { ...payoutBatchPending, items: [] } },
    { name: 'no item list', body: { ...payoutBatchPending, items: undefined } },
  ])('reports no item status for a batch with $name', async ({ body }) => {
    stubFetch([{ method: 'GET', path: `${PAYOUTS}/${BATCH_ID}`, body }]);

    expect(await getPayoutBatch(BATCH_ID)).toEqual({ batchStatus: 'PENDING', itemStatus: null });
  });

  it('encodes the batch id, so it stays one segment of the path', async () => {
    const calls = stubFetch([{ method: 'GET', path: `${PAYOUTS}/AB%2FCD%3Fx%3D1`, body: payoutBatchSuccess }]);

    await getPayoutBatch('AB/CD?x=1');

    const [get] = apiCalls(calls);
    expect(get.url).toBe('https://api-m.sandbox.paypal.com/v1/payments/payouts/AB%2FCD%3Fx%3D1');
  });

  it('fails, naming the batch, when the response has no batch status', async () => {
    const { batch_header: header } = payoutBatchSuccess;
    const body = { ...payoutBatchSuccess, batch_header: { ...header, batch_status: undefined } };
    stubFetch([{ method: 'GET', path: `${PAYOUTS}/${BATCH_ID}`, body }]);

    await expect(getPayoutBatch(BATCH_ID)).rejects.toThrow(BATCH_ID);
  });
});
