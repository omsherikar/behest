import { describe, expect, it } from 'vitest';
import { budgetEffect, burnDown, periodBounds, type BudgetPurchase } from '@/lib/dashboard/budget';
import { purchaseStatus } from '@/lib/db/schema';

const at = (iso: string) => new Date(iso);
const CONFIRMED = at('2026-11-02T09:30:00Z');

describe('budgetEffect', () => {
  it('counts captured money as spent and unpaid live purchases as reservations in flight', () => {
    const byEffect = Object.groupBy(purchaseStatus.enumValues, budgetEffect);
    expect(byEffect).toEqual({
      in_flight: ['proposed', 'charging', 'awaiting_approval'],
      spent: ['captured', 'accepted', 'settled', 'disputed', 'resolved'],
      released: ['blocked', 'cancelled', 'failed', 'refunded'],
    });
  });
});

describe('periodBounds', () => {
  it('runs a day from UTC midnight to the next', () => {
    expect(periodBounds('day', at('2026-11-06T23:59:59Z'), CONFIRMED, null)).toEqual({
      start: at('2026-11-06T00:00:00Z'),
      end: at('2026-11-07T00:00:00Z'),
    });
  });

  it('runs a week from Monday 00:00 UTC, so a Sunday belongs to the week before', () => {
    expect(periodBounds('week', at('2026-11-08T12:00:00Z'), CONFIRMED, null)).toEqual({
      start: at('2026-11-02T00:00:00Z'),
      end: at('2026-11-09T00:00:00Z'),
    });
    expect(periodBounds('week', at('2026-11-09T00:00:00Z'), CONFIRMED, null).start).toEqual(at('2026-11-09T00:00:00Z'));
  });

  it('runs a month from the first, across a year end', () => {
    expect(periodBounds('month', at('2026-11-30T23:59:59Z'), CONFIRMED, null)).toEqual({
      start: at('2026-11-01T00:00:00Z'),
      end: at('2026-12-01T00:00:00Z'),
    });
    expect(periodBounds('month', at('2026-12-15T08:00:00Z'), CONFIRMED, null)).toEqual({
      start: at('2026-12-01T00:00:00Z'),
      end: at('2027-01-01T00:00:00Z'),
    });
  });

  it('runs a one-off budget from confirmation to expiry, or with no end', () => {
    const expires = at('2026-12-31T00:00:00Z');
    expect(periodBounds('once', at('2026-11-06T12:00:00Z'), CONFIRMED, expires)).toEqual({ start: CONFIRMED, end: expires });
    expect(periodBounds('once', at('2026-11-06T12:00:00Z'), CONFIRMED, null)).toEqual({ start: CONFIRMED, end: null });
  });
});

describe('burnDown', () => {
  const week = { start: at('2026-11-02T00:00:00Z'), end: at('2026-11-09T00:00:00Z') };
  const purchase = (id: string, createdAt: string, totalCents: number, status: BudgetPurchase['status']): BudgetPurchase => ({
    id,
    createdAt: at(createdAt),
    totalCents,
    status,
  });

  it('starts with the whole budget left', () => {
    expect(burnDown(6000, week, [])).toEqual({
      budgetCents: 6000,
      ...week,
      spentCents: 0,
      inFlightCents: 0,
      remainingCents: 6000,
      steps: [],
    });
  });

  it('steps down in time order, keeping spend and reservations in flight apart', () => {
    const result = burnDown(6000, week, [
      purchase('ask', '2026-11-05T10:00:00Z', 4000, 'awaiting_approval'),
      purchase('allow', '2026-11-03T10:00:00Z', 1875, 'settled'),
    ]);
    expect(result).toMatchObject({ spentCents: 1875, inFlightCents: 4000, remainingCents: 125 });
    expect(result.steps).toEqual([
      {
        purchaseId: 'allow',
        at: at('2026-11-03T10:00:00Z'),
        effect: 'spent',
        amountCents: 1875,
        spentCents: 1875,
        inFlightCents: 0,
        remainingCents: 4125,
      },
      {
        purchaseId: 'ask',
        at: at('2026-11-05T10:00:00Z'),
        effect: 'in_flight',
        amountCents: 4000,
        spentCents: 1875,
        inFlightCents: 4000,
        remainingCents: 125,
      },
    ]);
  });

  it('ignores released purchases and purchases outside the period', () => {
    const result = burnDown(6000, week, [
      purchase('blocked', '2026-11-03T10:00:00Z', 900, 'blocked'),
      purchase('refunded', '2026-11-03T11:00:00Z', 800, 'refunded'),
      purchase('last-week', '2026-11-01T23:59:59Z', 700, 'settled'),
      purchase('next-week', '2026-11-09T00:00:00Z', 600, 'settled'),
      purchase('first-instant', '2026-11-02T00:00:00Z', 500, 'captured'),
    ]);
    expect(result.steps.map((s) => s.purchaseId)).toEqual(['first-instant']);
    expect(result.remainingCents).toBe(5500);
  });

  it('counts everything since the start when the period has no end', () => {
    const result = burnDown(6000, { start: CONFIRMED, end: null }, [purchase('later', '2027-03-01T00:00:00Z', 2500, 'accepted')]);
    expect(result.spentCents).toBe(2500);
  });

  it('skips purchases without a total, which never reached a valid cart', () => {
    const result = burnDown(6000, week, [{ ...purchase('no-cart', '2026-11-03T10:00:00Z', 0, 'proposed'), totalCents: null }]);
    expect(result.steps).toEqual([]);
  });
});
