import { expect, it } from 'vitest';
import { fakeFetch } from '@/tests/helpers/fake-fetch';

it('fakeFetch returns the matching body and records the call', async () => {
  const f = fakeFetch([{ method: 'POST', path: '/v1/x', body: { ok: true } }]);
  const res = await f.fetch('https://h/v1/x', { method: 'POST', body: '{}', headers: { 'PayPal-Request-Id': 'p1' } });
  expect(await res.json()).toEqual({ ok: true });
  expect(f.calls[0].headers['paypal-request-id']).toBe('p1');
});
it('fakeFetch throws on an unmatched request', async () => {
  await expect(fakeFetch([]).fetch('https://h/none')).rejects.toThrow(/unmatched/i);
});
