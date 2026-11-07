import { join } from 'node:path';
import { expect, it } from 'vitest';
import { GET } from '@/app/api/health/route';
import { modulesReachedFrom, REPO_ROOT } from '@/tests/helpers/module-graph';

it('answers 200 with ok', async () => {
  const response = GET();

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

it('reaches no database module, so it answers while the database is down or still starting', () => {
  const reached = [...modulesReachedFrom(join(REPO_ROOT, 'app/api/health/route.ts'))];
  expect(reached).toContain('app/api/health/route.ts');
  expect(reached.filter((path) => /^lib\/db\b/.test(path))).toEqual([]);
});
