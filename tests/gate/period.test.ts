import { afterEach, expect, it } from 'vitest';
import type { BudgetPeriod } from '@/lib/domain/policy';
import { periodStart } from '@/lib/gate/period';

const at = (iso: string) => new Date(iso);
const confirmedAt = at('2026-10-15T09:30:00Z');

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

it('starts a day at UTC midnight', () => {
  expect(periodStart('day', at('2026-11-06T15:42:10Z'), confirmedAt)).toEqual(at('2026-11-06T00:00:00Z'));
  expect(periodStart('day', at('2026-11-06T00:00:00Z'), confirmedAt)).toEqual(at('2026-11-06T00:00:00Z'));
  expect(periodStart('day', at('2026-11-06T23:59:59.999Z'), confirmedAt)).toEqual(at('2026-11-06T00:00:00Z'));
});

it('starts a week on Monday at UTC midnight', () => {
  expect(periodStart('week', at('2026-11-08T12:00:00Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
  expect(periodStart('week', at('2026-11-06T18:00:00Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
  expect(periodStart('week', at('2026-11-08T23:59:59.999Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
});

it('starts a week at the current instant when now is exactly Monday midnight UTC', () => {
  expect(periodStart('week', at('2026-11-02T00:00:00Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
});

it('starts a week in the previous month or year when Monday falls there', () => {
  expect(periodStart('week', at('2026-11-01T10:00:00Z'), confirmedAt)).toEqual(at('2026-10-26T00:00:00Z'));
  expect(periodStart('week', at('2027-01-01T10:00:00Z'), confirmedAt)).toEqual(at('2026-12-28T00:00:00Z'));
});

it('starts a month on the first at UTC midnight', () => {
  expect(periodStart('month', at('2026-11-30T23:59:59Z'), confirmedAt)).toEqual(at('2026-11-01T00:00:00Z'));
  expect(periodStart('month', at('2026-12-01T00:00:00Z'), confirmedAt)).toEqual(at('2026-12-01T00:00:00Z'));
});

it('keeps month starts in the right year across the year boundary', () => {
  expect(periodStart('month', at('2026-12-31T23:59:59Z'), confirmedAt)).toEqual(at('2026-12-01T00:00:00Z'));
  expect(periodStart('month', at('2027-01-01T00:00:00Z'), confirmedAt)).toEqual(at('2027-01-01T00:00:00Z'));
});

it('starts a one-off budget when the mandate was confirmed', () => {
  expect(periodStart('once', at('2026-11-06T15:42:10Z'), confirmedAt)).toEqual(confirmedAt);
});

it('throws on a period it does not know instead of returning no start', () => {
  expect(() => periodStart('fortnight' as BudgetPeriod, at('2026-11-06T15:42:10Z'), confirmedAt)).toThrow(
    'unknown budget period',
  );
});

it('returns a new date and leaves its inputs untouched', () => {
  const now = at('2026-11-08T12:00:00Z');
  const confirmed = at('2026-10-15T09:30:00Z');
  for (const period of ['day', 'week', 'month', 'once'] as const) {
    const start = periodStart(period, now, confirmed);
    expect(start).not.toBe(now);
    expect(start).not.toBe(confirmed);
  }
  expect(now).toEqual(at('2026-11-08T12:00:00Z'));
  expect(confirmed).toEqual(at('2026-10-15T09:30:00Z'));
});

it.each(['Asia/Kolkata', 'America/Los_Angeles'])('gives the same UTC period starts when the process runs in %s', (tz) => {
  process.env.TZ = tz;
  // Guard: the zone switch really took effect, so local calendar fields now differ from UTC ones.
  const probe = at('2026-11-30T23:59:59Z');
  expect([probe.getDate(), probe.getHours()]).not.toEqual([probe.getUTCDate(), probe.getUTCHours()]);

  expect(periodStart('month', at('2026-11-30T23:59:59Z'), confirmedAt)).toEqual(at('2026-11-01T00:00:00Z'));
  expect(periodStart('month', at('2026-12-01T00:00:00Z'), confirmedAt)).toEqual(at('2026-12-01T00:00:00Z'));
  expect(periodStart('week', at('2026-11-08T12:00:00Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
  expect(periodStart('week', at('2026-11-02T00:00:00Z'), confirmedAt)).toEqual(at('2026-11-02T00:00:00Z'));
  expect(periodStart('day', at('2026-11-06T20:00:00Z'), confirmedAt)).toEqual(at('2026-11-06T00:00:00Z'));
});
