import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// The attack replay's numbers for the home page, read when the page is built from
// lib/security/results.json, which `npm run attack:replay` writes. Nothing here is typed in by hand:
// without the file, or with one this code cannot read, the page shows no numbers at all.

/** The parts of results.json the home page reads; the full schema lives beside the replay. */
const Results = z.object({
  deterministic: z.array(z.unknown()),
  live: z
    .object({
      calls: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      results: z.array(z.object({ state: z.string() })),
    })
    .nullable(),
});

export type SecurityStats = {
  /** Attacks replayed against the deterministic layers. */
  attacks: number;
  /** The live run against Claude, when it has been run. */
  live: { ran: number; stopped: number; calls: number; costUsd: number } | null;
};

export function readSecurityStats(file = path.join(process.cwd(), 'lib', 'security', 'results.json')): SecurityStats | null {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = Results.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const { deterministic, live } = parsed.data;
  return {
    attacks: deterministic.length,
    live: live && {
      ran: live.results.length,
      stopped: live.results.filter((result) => result.state === 'stopped').length,
      calls: live.calls,
      costUsd: live.costUsd,
    },
  };
}
