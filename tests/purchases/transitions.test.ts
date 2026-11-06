import { expect, expectTypeOf, it } from 'vitest';
import { purchaseStatus, type PurchaseStatus as SchemaPurchaseStatus } from '@/lib/db/schema';
import {
  ALLOWED,
  assertTransition,
  canTransition,
  COUNTS_AGAINST_BUDGET,
  IllegalTransition,
  type PurchaseStatus,
} from '@/lib/purchases/transitions';

const STATUSES = purchaseStatus.enumValues;

// Written out by hand from the lifecycle diagram, so the table is checked against a separate copy.
const LEGAL = new Set([
  'proposed -> blocked',
  'proposed -> charging',
  'proposed -> awaiting_approval',
  'awaiting_approval -> charging',
  'awaiting_approval -> cancelled',
  'charging -> captured',
  'charging -> failed',
  'captured -> accepted',
  'captured -> refunded',
  'accepted -> settled',
  'accepted -> refunded',
  'settled -> disputed',
  'settled -> refunded',
  'disputed -> resolved',
  'disputed -> refunded',
]);

const TERMINAL: PurchaseStatus[] = ['blocked', 'cancelled', 'failed', 'refunded', 'resolved'];
const NOT_COUNTED: PurchaseStatus[] = ['blocked', 'cancelled', 'failed', 'refunded'];

const pairs = STATUSES.flatMap((from) =>
  STATUSES.map((to) => ({ from, to, legal: LEGAL.has(`${from} -> ${to}`) })),
);

function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

it('re-exports the status type from the schema instead of redefining it', () => {
  expectTypeOf<PurchaseStatus>().toEqualTypeOf<SchemaPurchaseStatus>();
});

it('covers every ordered pair of statuses, and every legal pair names real statuses', () => {
  // A new status changes these counts, so the legal set above has to be revisited.
  expect(STATUSES).toHaveLength(12);
  expect(pairs).toHaveLength(144);
  expect(pairs.filter((pair) => pair.legal)).toHaveLength(LEGAL.size);
});

it.each(pairs.filter((pair) => pair.legal))('allows $from to $to', ({ from, to }) => {
  expect(canTransition(from, to)).toBe(true);
  expect(() => assertTransition(from, to)).not.toThrow();
});

it.each(pairs.filter((pair) => !pair.legal))('refuses $from to $to', ({ from, to }) => {
  expect(canTransition(from, to)).toBe(false);
  const error = thrownBy(() => assertTransition(from, to));
  expect(error).toBeInstanceOf(IllegalTransition);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: 'IllegalTransition',
    from,
    to,
    message: `cannot move a purchase from ${from} to ${to}`,
  });
});

it('never moves a purchase to the status it already has', () => {
  for (const status of STATUSES) {
    expect(canTransition(status, status)).toBe(false);
  }
});

it('lets nothing leave a terminal status, and only those statuses are terminal', () => {
  expect(STATUSES.filter((status) => ALLOWED[status].length === 0)).toEqual(TERMINAL);
  for (const from of TERMINAL) {
    for (const to of STATUSES) {
      expect(canTransition(from, to)).toBe(false);
    }
  }
});

it('counts every status against the budget except blocked, cancelled, failed and refunded', () => {
  const expected = STATUSES.filter((status) => !NOT_COUNTED.includes(status));
  expect([...COUNTS_AGAINST_BUDGET].sort()).toEqual([...expected].sort());
  expect(COUNTS_AGAINST_BUDGET).toHaveLength(8);
});
