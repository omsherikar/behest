// In-memory token buckets for routes that call a model. Each key (for example a route and a
// visitor) gets `capacity` tokens; a request spends one, and tokens come back at
// `refillPerMinute`. Buckets live in this server process only, which suits a single-instance demo.

export type RateLimitOptions = { capacity: number; refillPerMinute: number };

/** The limit for model-backed routes: bursts of 10, then 10 a minute. */
export const MODEL_ROUTE_LIMIT: Readonly<RateLimitOptions> = { capacity: 10, refillPerMinute: 10 };

/**
 * The limit for the dashboard analyst: bursts of 30, then 20 a minute. Each turn of a question is
 * one request, and a question that runs tools takes several turns.
 */
export const STUDIO_ANALYST_LIMIT: Readonly<RateLimitOptions> = { capacity: 30, refillPerMinute: 20 };

type Bucket = { tokens: number; at: number };

/** A rate limiter on the given clock (milliseconds). Tests pass their own clock. */
export function createRateLimiter(now: () => number = () => Date.now()) {
  const buckets = new Map<string, Bucket>();

  /** Spends a token for `key` and returns true, or returns false when the bucket is empty. */
  return function rateLimit(key: string, { capacity, refillPerMinute }: RateLimitOptions): boolean {
    const at = now();
    const last = buckets.get(key);
    const tokens = last ? Math.min(capacity, last.tokens + ((at - last.at) * refillPerMinute) / 60_000) : capacity;
    // A refusal changes nothing, so the refill is always measured from the last spent token. That
    // keeps a clock that steps backwards from crediting the same time twice.
    if (tokens < 1) return false;
    buckets.set(key, { tokens: tokens - 1, at });
    return true;
  };
}

/** The app's rate limiter, on the system clock. */
export const rateLimit = createRateLimiter();

/** The client's address as the hosting platform reports it, which sets both headers itself. */
export function clientAddress(request: Request): string {
  return request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';
}
