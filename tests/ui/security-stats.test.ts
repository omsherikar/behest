import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSecurityStats } from '@/app/_landing/security-stats';

// The home page's attack replay numbers come from the replay's results file or not at all.

const dir = mkdtempSync(path.join(os.tmpdir(), 'security-stats-'));
const write = (name: string, body: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
};

describe('readSecurityStats', () => {
  it('shows nothing when the results file is absent', () => {
    expect(readSecurityStats(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('shows nothing when the file cannot be read as results', () => {
    expect(readSecurityStats(write('broken.json', '{"deterministic":'))).toBeNull();
    expect(readSecurityStats(write('wrong.json', '{"deterministic": 3, "live": null}'))).toBeNull();
  });

  it('counts the attacks before any live run', () => {
    const file = write('deterministic.json', JSON.stringify({ version: 1, mandate: [], deterministic: [{}, {}, {}], live: null }));
    expect(readSecurityStats(file)).toEqual({ attacks: 3, live: null });
  });

  it('counts what the live run stopped, its calls and its cost', () => {
    const live = {
      ranAt: '2026-11-07T13:54:12.355Z',
      calls: 38,
      costUsd: 0.312542,
      results: [{ state: 'stopped' }, { state: 'flagged' }, { state: 'stopped' }],
      skipped: [],
    };
    const file = write('live.json', JSON.stringify({ version: 1, mandate: [], deterministic: [{}, {}, {}], live }));
    expect(readSecurityStats(file)).toEqual({ attacks: 3, live: { ran: 3, stopped: 2, calls: 38, costUsd: 0.312542 } });
  });
});
