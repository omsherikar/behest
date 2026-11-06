import { afterEach, expect, it, vi } from 'vitest';
import { register } from '@/instrumentation';
import { loadJobHandlers } from '@/lib/jobs/registry';
import { startWorker } from '@/lib/jobs/worker';

vi.mock('@/lib/jobs/worker', () => ({ startWorker: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('starts the job worker with the registered handlers on the Node.js runtime when WORKER is 1', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('WORKER', '1');
  await register();
  expect(startWorker).toHaveBeenCalledExactlyOnceWith(loadJobHandlers);
});

it('does not start the job worker unless WORKER is 1', async () => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  for (const worker of [undefined, '', '0', 'true']) {
    vi.stubEnv('WORKER', worker);
    await register();
  }
  expect(startWorker).not.toHaveBeenCalled();
});

it('does not start the job worker on the edge runtime or outside Next.js', async () => {
  vi.stubEnv('WORKER', '1');
  for (const runtime of ['edge', undefined]) {
    vi.stubEnv('NEXT_RUNTIME', runtime);
    await register();
  }
  expect(startWorker).not.toHaveBeenCalled();
});
