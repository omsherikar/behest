// How the buyer's mandate pages talk to Behest's routes: JSON in, JSON out, and a failure the buyer
// can read. Shared by the mandate form and its passkey signing.

/** What a mandate confirm returns. `approveUrl` is null when the buyer's wallet is already linked. */
export type Signed = { mandateId: string; approveUrl: string | null };

/** An error message from a route, as a sentence: capitalized, with a full stop. */
export function sentence(message: string): string {
  const text = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A failed request, with a message the buyer can read, the HTTP status (null when nothing came back)
 * and the route's error code, when it sent one.
 */
export class RequestFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** POSTs JSON to a route and returns its JSON body, or throws RequestFailed. */
export async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new RequestFailed('Could not reach Behest. Check your connection and try again.', null);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (json as { error?: { message?: unknown; code?: unknown } } | null)?.error;
    const message = typeof error?.message === 'string' ? sentence(error.message) : 'Something went wrong. Try again.';
    throw new RequestFailed(message, response.status, typeof error?.code === 'string' ? error.code : undefined);
  }
  return json as T;
}
