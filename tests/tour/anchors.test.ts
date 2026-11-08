import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TOUR_STEPS } from '@/lib/tour/steps';
import { REPO_ROOT } from '@/tests/helpers/module-graph';

// Every element the guided demo rings carries a data-tour anchor in the source, exactly once, so a
// renamed or deleted anchor fails here rather than leaving a step with nothing to point at.

function sources(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'));
}

const files = [...sources('app'), ...sources('components')];

it.each(TOUR_STEPS.filter((step) => step.anchor !== null).map((step) => [step.id, step.anchor as string]))(
  'the %s step finds data-tour="%s" exactly once in the pages',
  (_, anchor) => {
    const count = files.reduce((sum, text) => sum + text.split(`data-tour="${anchor}"`).length - 1, 0);
    expect(count).toBe(1);
  },
);
