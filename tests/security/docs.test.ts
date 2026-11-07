import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS, readResults, RESULTS_END, RESULTS_START, resultsBlock } from '@/lib/security/view';

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

describe('docs/security.md', () => {
  const doc = read('docs', 'security.md');

  it('carries the results table and live note that lib/security/results.json gives', () => {
    const block = doc.slice(doc.indexOf(RESULTS_START) + RESULTS_START.length, doc.indexOf(RESULTS_END));
    const results = readResults(JSON.parse(read('lib', 'security', 'results.json')));

    expect(block).toBe(`\n${resultsBlock(results)}\n`);
  });

  it('states every limit the security page states', () => {
    for (const limit of LIMITS) expect(doc, limit.title).toContain(`**${limit.title}** ${limit.detail}`);
  });
});
