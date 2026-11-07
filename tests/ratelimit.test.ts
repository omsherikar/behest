import { describe, expect, it } from 'vitest';
import {
  clientAddress,
  createRateLimiter,
  MAX_TRACKED_KEYS,
  MODEL_ROUTE_LIMIT,
  PUBLIC_READ_LIMIT,
  PUBLIC_WRITE_LIMIT,
  rateLimit,
  STUDIO_ANALYST_LIMIT,
} from '@/lib/ratelimit';

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

  it('uses a bucket of 60 refilled at 60 a minute for public reads, and 20 at 20 a minute for public writes', () => {
    expect(PUBLIC_READ_LIMIT).toEqual({ capacity: 60, refillPerMinute: 60 });
    expect(PUBLIC_WRITE_LIMIT).toEqual({ capacity: 20, refillPerMinute: 20 });
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

  it('tracks at most 10,000 keys however many it sees, and forgets the oldest first', () => {
    const { limit } = limiterAt();
    const once = { capacity: 1, refillPerMinute: 1 };
    let most = 0;
    for (let i = 0; i < 25_000; i += 1) {
      limit(`visitor-${i}`, once);
      most = Math.max(most, limit.tracked());
    }

    expect(MAX_TRACKED_KEYS).toBe(10_000);
    expect(most).toBeLessThanOrEqual(10_000);
    // It uses the room it has: more than one generation of keys at its fullest.
    expect(most).toBeGreaterThan(5_000);
    expect(limit('visitor-24999', once)).toBe(false);
    expect(limit('visitor-0', once)).toBe(true);
  });

  it('forgets the least recently seen key first, which then starts again with a full bucket', () => {
    const limit = createRateLimiter(() => 0, 4);
    const once = { capacity: 1, refillPerMinute: 1 };
    expect(limit('a', once)).toBe(true);
    expect(limit('a', once)).toBe(false);
    limit('b', once);
    limit('c', once);
    // Seen again, so b is now more recent than a.
    limit('b', once);

    expect(limit.tracked()).toBeLessThanOrEqual(4);
    expect(limit('c', once)).toBe(false);
    expect(limit('b', once)).toBe(false);
    expect(limit('a', once)).toBe(true);
  });

  it('keeps a key that is still being refused, so asking again never resets its bucket', () => {
    const limit = createRateLimiter(() => 0, 4);
    const once = { capacity: 1, refillPerMinute: 1 };
    limit('a', once);
    limit('b', once);

    for (let i = 0; i < 20; i += 1) {
      limit(`visitor-${i}`, once);
      expect(limit('a', once)).toBe(false);
      expect(limit.tracked()).toBeLessThanOrEqual(4);
    }
    // b was seen only once, so it has long been forgotten.
    expect(limit('b', once)).toBe(true);
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

  it('takes the right-most x-forwarded-for entry, the one the hosting proxy appends', () => {
    expect(clientAddress(requestWith({ 'x-forwarded-for': ' 10.0.0.1 , 203.0.113.7 ' }))).toBe('203.0.113.7');
    expect(clientAddress(requestWith({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('gives the same address whatever a client writes in the entries before it', () => {
    for (const claimed of ['198.51.100.4', '1.1.1.1, 2.2.2.2', 'unknown', '']) {
      const forwarded = claimed === '' ? '203.0.113.7' : `${claimed}, 203.0.113.7`;
      expect(clientAddress(requestWith({ 'x-forwarded-for': forwarded }))).toBe('203.0.113.7');
    }
  });

  it('ignores x-real-ip when x-forwarded-for is set', () => {
    expect(clientAddress(requestWith({ 'x-real-ip': '198.51.100.4', 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('takes x-real-ip when there is no x-forwarded-for', () => {
    expect(clientAddress(requestWith({ 'x-real-ip': ' 198.51.100.4 ' }))).toBe('198.51.100.4');
  });

  it('reads unknown when neither header is set', () => {
    expect(clientAddress(requestWith({}))).toBe('unknown');
  });
});
