// A fake PayPal for tests of the PayPal REST client. It replaces the global fetch, hands out an
// OAuth token, and records every request so tests can read back what PayPal received.

import { vi } from 'vitest';
import { fakeFetch, type FakeRoute, type RecordedCall } from '@/tests/helpers/fake-fetch';

const TOKEN_PATH = '/v1/oauth2/token';

/** PayPal's OAuth token endpoint, giving the same token to every request. */
export const oauth: FakeRoute = {
  method: 'POST',
  path: TOKEN_PATH,
  body: { access_token: 'T1', token_type: 'Bearer', expires_in: 32_400 },
};

/** Stubs fetch with a PayPal that serves the token and `routes`, and returns the requests it receives. */
export function stubFetch(routes: FakeRoute[]): RecordedCall[] {
  const f = fakeFetch([oauth, ...routes]);
  vi.stubGlobal('fetch', f.fetch);
  return f.calls;
}

/** Like stubFetch, but PayPal receives the first request to `path` and its response never arrives. */
export function stubFetchLosingFirstResponse(routes: FakeRoute[], path: string): { calls: RecordedCall[]; lost: TypeError } {
  const f = fakeFetch([oauth, ...routes]);
  const lost = new TypeError('fetch failed');
  let dropNext = true;
  const flaky: typeof fetch = async (input, init) => {
    const response = await f.fetch(input, init);
    if (dropNext && new URL(String(input)).pathname === path) {
      dropNext = false;
      throw lost;
    }
    return response;
  };
  vi.stubGlobal('fetch', flaky);
  return { calls: f.calls, lost };
}

/** The requests other than token requests. */
export const apiCalls = (calls: RecordedCall[]) => calls.filter((c) => new URL(c.url).pathname !== TOKEN_PATH);
