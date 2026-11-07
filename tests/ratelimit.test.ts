import { describe, expect, it } from 'vitest';
import { clientAddress, createRateLimiter, MODEL_ROUTE_LIMIT, rateLimit, STUDIO_ANALYST_LIMIT } from '@/lib/ratelimit';

/** A limiter on a clock the test moves by hand. */
function limiterAt(start = 0) {
  let now = start;
  const limit = createRateLimiter(() => now);
  return { limit, advance: (ms: number) => (now += ms) };
}

/** How many of `attempts` calls in a row the limiter allows. */
function allowed(limit: ReturnType<typeof createRateLimiter>, key: string, attempts: number) {
  return Array.from({ length: attempts }, () => limit(key, MODEL_ROUTE_LIMIT)).filter(Boolean).length;
}

describe('rate limiter', () => {
  it('uses a bucket of 10 refilled at 10 a minute for model routes', () => {
    expect(MODEL_ROUTE_LIMIT).toEqual({ capacity: 10, refillPerMinute: 10 });
  });

  it('uses a bucket of 30 refilled at 20 a minute for the dashboard analyst, whose questions take several turns', () => {
    expect(STUDIO_ANALYST_LIMIT).toEqual({ capacity: 30, refillPerMinute: 20 });
  });

  it('allows 10 then refuses', () => {
    const { limit } = limiterAt();
    expect(allowed(limit, 'visitor', 10)).toBe(10);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(false);
  });

  it('refills one token every six seconds at 10 a minute', () => {
    const { limit, advance } = limiterAt();
    allowed(limit, 'visitor', 10);

    advance(5_999);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(false);
    advance(1);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(true);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(false);
  });

  it('refills to capacity and no further', () => {
    const { limit, advance } = limiterAt();
    allowed(limit, 'visitor', 10);

    advance(60 * 60_000);
    expect(allowed(limit, 'visitor', 11)).toBe(10);
  });

  it('keeps a separate bucket per key', () => {
    const { limit } = limiterAt();
    allowed(limit, 'buyer', 10);
    expect(limit('buyer', MODEL_ROUTE_LIMIT)).toBe(false);
    expect(limit('seller', MODEL_ROUTE_LIMIT)).toBe(true);
  });

  it('never credits the same minute twice when the clock steps backwards', () => {
    const { limit, advance } = limiterAt(1_000_000);
    allowed(limit, 'visitor', 10);

    advance(-60_000);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(false);
    advance(60_000);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(false);
    advance(6_000);
    expect(limit('visitor', MODEL_ROUTE_LIMIT)).toBe(true);
  });

  it('exports a ready limiter on the system clock', () => {
    const opts = { capacity: 1, refillPerMinute: 1 };
    const key = `system-clock-${Math.random()}`;
    expect(rateLimit(key, opts)).toBe(true);
    expect(rateLimit(key, opts)).toBe(false);
  });
});

describe('client address', () => {
  const requestWith = (headers: Record<string, string>) => new Request('http://localhost/api', { headers });

  it('takes the address the platform sets in x-real-ip', () => {
    expect(clientAddress(requestWith({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' }))).toBe('198.51.100.4');
  });

  it('takes the first x-forwarded-for address when there is no x-real-ip', () => {
    expect(clientAddress(requestWith({ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('reads unknown when neither header is set', () => {
    expect(clientAddress(requestWith({}))).toBe('unknown');
  });
});
