// In-memory token buckets for routes that call a model or are open to anyone. Each key (for example
// a route and a visitor) gets `capacity` tokens; a request spends one, and tokens come back at
// `refillPerMinute`. Buckets live in this server process only, which suits a single-instance demo.

export type RateLimitOptions = { capacity: number; refillPerMinute: number };

/** The limit for model-backed routes: bursts of 10, then 10 a minute. */
export const MODEL_ROUTE_LIMIT: Readonly<RateLimitOptions> = { capacity: 10, refillPerMinute: 10 };

/**
 * The limit for the dashboard analyst: bursts of 30, then 20 a minute. Each turn of a question is
 * one request, and a question that runs tools takes several turns.
 */
export const STUDIO_ANALYST_LIMIT: Readonly<RateLimitOptions> = { capacity: 30, refillPerMinute: 20 };

/** The limit for public reads, such as a seller's catalog or a receipt check: bursts of 60, then 60 a minute. */
export const PUBLIC_READ_LIMIT: Readonly<RateLimitOptions> = { capacity: 60, refillPerMinute: 60 };

/** The limit for public writes, such as an agent placing an order: bursts of 20, then 20 a minute. */
export const PUBLIC_WRITE_LIMIT: Readonly<RateLimitOptions> = { capacity: 20, refillPerMinute: 20 };

/**
 * The limit for an operator's messages to a buyer at PayPal: bursts of 5, then 5 a minute. Each one
 * reads the dispute at PayPal and may reach the buyer, and an answer takes one or two.
 */
export const BUYER_MESSAGE_LIMIT: Readonly<RateLimitOptions> = { capacity: 5, refillPerMinute: 5 };

/**
 * The most keys a limiter ever tracks. Keys seen least recently are forgotten a generation at a time,
 * so some go before this bound is reached; forgetting a key only hands it a full bucket again, which
 * an idle key would have refilled to anyway.
 */
export const MAX_TRACKED_KEYS = 10_000;

type Bucket = { tokens: number; at: number };

/**
 * A rate limiter on the given clock (milliseconds), tracking at most `maxKeys` keys. Tests pass
 * their own clock and bound. `tracked()` is how many keys it holds.
 */
export function createRateLimiter(now: () => number = () => Date.now(), maxKeys: number = MAX_TRACKED_KEYS) {
  // Keys live in two generations. Each call keeps its key in the current one, moving it out of the
  // previous one if it was there. When the current generation fills, it becomes the previous one
  // and the old previous one, every key not seen since, is dropped whole. Each call costs a few Map
  // operations, and the two together never hold more than `maxKeys`.
  const generation = Math.max(1, Math.ceil(maxKeys / 2));
  let current = new Map<string, Bucket>();
  let previous = new Map<string, Bucket>();

  /** Keeps `bucket` for `key` as just seen. */
  function keep(key: string, bucket: Bucket): void {
    previous.delete(key);
    current.set(key, bucket);
    if (current.size >= generation) {
      previous = current;
      current = new Map();
    }
  }

  /** Spends a token for `key` and returns true, or returns false when the bucket is empty. */
  function rateLimit(key: string, { capacity, refillPerMinute }: RateLimitOptions): boolean {
    const at = now();
    const last = current.get(key) ?? previous.get(key);
    const tokens = last ? Math.min(capacity, last.tokens + ((at - last.at) * refillPerMinute) / 60_000) : capacity;
    // A refusal leaves the bucket as it was, so the refill is always measured from the last spent
    // token. That keeps a clock that steps backwards from crediting the same time twice. The key
    // still counts as just seen, so a client that keeps asking is never forgotten into a full bucket.
    if (tokens < 1) {
      if (last) keep(key, last);
      return false;
    }
    keep(key, { tokens: tokens - 1, at });
    return true;
  }

  return Object.assign(rateLimit, { tracked: () => current.size + previous.size });
}

/** The app's rate limiter, on the system clock. */
export const rateLimit = createRateLimiter();

/**
 * How many proxies of the host's own append to x-forwarded-for, from TRUSTED_PROXY_HOPS: a whole
 * number of at least 1, or 1 when it is unset or anything else.
 */
function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim() ?? '';
  const hops = /^\d+$/.test(raw) ? Number(raw) : 0;
  return hops >= 1 ? hops : 1;
}

/** A header's value without the spaces around it, or null when it is missing or blank. */
function headerValue(request: Request, name: string): string | null {
  return request.headers.get(name)?.trim() || null;
}

/**
 * Whether Cloudflare's client address headers are trusted, from TRUST_CLOUDFLARE_HEADERS: only
 * when it is 1, set by a host that sits behind Cloudflare. Without Cloudflare in front, a client
 * can send these headers itself and pick any address it likes.
 */
function trustsCloudflareHeaders(): boolean {
  return process.env.TRUST_CLOUDFLARE_HEADERS?.trim() === '1';
}

/**
 * The client's address, from the first of these that is set:
 * - when TRUST_CLOUDFLARE_HEADERS is 1, cf-connecting-ip, then true-client-ip, which Cloudflare sets
 *   to the address that connected to it, replacing anything the client sent;
 * - the x-forwarded-for entry TRUSTED_PROXY_HOPS from the right: each trusted proxy appends the
 *   address it saw, so entries further left may be the client's own claim. With fewer entries than
 *   that, the left-most one;
 * - x-real-ip;
 * - otherwise `unknown`.
 */
export function clientAddress(request: Request): string {
  if (trustsCloudflareHeaders()) {
    const direct = headerValue(request, 'cf-connecting-ip') ?? headerValue(request, 'true-client-ip');
    if (direct) return direct;
  }
  const forwarded = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (forwarded.length > 0) return forwarded[Math.max(0, forwarded.length - trustedProxyHops())];
  return headerValue(request, 'x-real-ip') ?? 'unknown';
}
