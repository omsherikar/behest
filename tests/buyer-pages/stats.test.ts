import { describe, expect, it } from 'vitest';
import { ledgerStats } from '@/lib/buyer-pages/stats';

// The figures over the buyer's ledger: what the agent proposed, what was paid, what waits for the
// buyer and what was blocked, counted from the same rows the grid shows.

const row = (status: string, verdict: 'ALLOW' | 'ASK' | 'BLOCK', totalCents: number | null) =>
  ({ status, verdict, totalCents }) as Parameters<typeof ledgerStats>[0][number];

describe('ledgerStats', () => {
  it('counts nothing for an empty ledger', () => {
    expect(ledgerStats([])).toEqual({ proposed: 0, paid: 0, paidCents: 0, waiting: 0, blocked: 0 });
  });

  it('adds up only what is paid, and counts what waits and what was blocked', () => {
    const stats = ledgerStats([
      row('captured', 'ALLOW', 900),
      row('settled', 'ALLOW', 1875),
      row('disputed', 'ALLOW', 500),
      row('refunded', 'ALLOW', 4000),
      row('awaiting_approval', 'ASK', 4000),
      row('blocked', 'BLOCK', 1200),
      row('blocked', 'BLOCK', null),
    ]);
    expect(stats).toEqual({ proposed: 7, paid: 3, paidCents: 3275, waiting: 1, blocked: 2 });
  });
});
