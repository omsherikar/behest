export type FakeRoute = {
  method: string;
  /** Matched against the request URL's pathname: exact for a string, `test()` for a RegExp. */
  path: string | RegExp;
  status?: number;
  /** Sent back JSON-encoded. Ignored for statuses that cannot carry a body, such as 204. */
  body: unknown;
  /** When true the route answers one request, then is removed. */
  once?: boolean;
};

export type RecordedCall = {
  method: string;
  url: string;
  /** Header names are lowercased, as the Fetch API normalizes them. */
  headers: Record<string, string>;
  body: string | null;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function matchesPath(path: FakeRoute['path'], pathname: string): boolean {
  return typeof path === 'string' ? path === pathname : path.test(pathname);
}

/**
 * A `fetch` stand-in that answers from a fixed route table and records every
 * request it receives. Routes are tried in order; a request no route matches
 * rejects with an "unmatched request" error.
 */
export function fakeFetch(routes: FakeRoute[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const remaining = [...routes];
  const calls: RecordedCall[] = [];

  const fetchStub: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: request.body === null ? null : await request.text(),
    });

    const index = remaining.findIndex(
      (route) => route.method.toUpperCase() === request.method.toUpperCase() && matchesPath(route.path, pathname),
    );
    if (index === -1) {
      throw new Error(`fakeFetch: unmatched request ${request.method} ${request.url}`);
    }
    const route = remaining[index];
    if (route.once) remaining.splice(index, 1);

    const status = route.status ?? 200;
    if (NULL_BODY_STATUSES.has(status)) return new Response(null, { status });
    return new Response(JSON.stringify(route.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetch: fetchStub, calls };
}
