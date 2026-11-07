// Every PayPal REST call goes through paypalRequest. It adds the OAuth token, a JSON or multipart
// body and the PayPal-Request-Id, and retries only what is safe to send twice. Plain fetch, no SDK.
// Server-side only: it reads the client secret from the environment.

const BASE_URL = 'https://api-m.sandbox.paypal.com';
const TOKEN_PATH = '/v1/oauth2/token';
const MAX_ATTEMPTS = 4;
/**
 * How long PayPal has to answer one request, body included. A request still waiting then is
 * abandoned and throws, as a lost connection does, so nothing waits on PayPal for long.
 */
const REQUEST_TIMEOUT_MS = 20_000;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    /** The full response body. The message keeps only its start. */
    readonly body: string,
  ) {
    super(`PayPal ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = 'PayPalApiError';
  }
}

export type PaypalRequestOptions = {
  /** Sent JSON-encoded. */
  body?: unknown;
  /** Sent as `PayPal-Request-Id`. PayPal answers a repeated id with the first result. */
  requestId?: string;
  headers?: Record<string, string>;
  /** Sent as multipart/form-data, with the boundary chosen by fetch. */
  form?: FormData;
};

let cachedToken: { value: string; expiresAt: number } | undefined;
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)');

  const res = await fetch(`${BASE_URL}${TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new PayPalApiError(res.status, TOKEN_PATH, await res.text());

  const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so an in-flight request never carries an expired token.
  cachedToken = { value: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
  return access_token;
}

// Network errors and timeouts are not retried here: they propagate so the caller, which knows whether
// money may have moved, decides whether to repeat the call with the same request id.
export async function paypalRequest<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  opts: PaypalRequestOptions = {},
): Promise<T> {
  if (opts.form && opts.body !== undefined) throw new Error('paypalRequest takes a JSON body or a form, not both');
  const body = opts.form ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  // A GET changes nothing, and a write that carries a request id is applied at most once by PayPal.
  const retryable = method === 'GET' || opts.requestId !== undefined;
  let refreshed = false;

  for (let attempt = 1; ; attempt++) {
    const headers = new Headers();
    if (typeof body === 'string') headers.set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
    headers.set('Authorization', `Bearer ${await accessToken()}`);
    if (opts.requestId !== undefined) headers.set('PayPal-Request-Id', opts.requestId);

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

    // PayPal rejects a stale token before acting on the request, so any method may retry once.
    if (res.status === 401 && !refreshed && attempt < MAX_ATTEMPTS) {
      refreshed = true;
      cachedToken = undefined;
      continue;
    }
    if (retryable && (res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await sleep(2 ** attempt * 250);
      continue;
    }
    throw new PayPalApiError(res.status, path, text);
  }
}

/** For tests: forget the cached token, so each test starts with no token. */
export function resetPaypalTokenCacheForTests(): void {
  cachedToken = undefined;
}

/** For tests: replace the wait between retries, so tests neither sleep nor depend on timers. */
export function setPaypalRetrySleepForTests(wait: (ms: number) => Promise<void>): void {
  sleep = wait;
}
