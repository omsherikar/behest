import { connection } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/tour/route';
import { NO_PINS } from '@/lib/tour/pins';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));

const HELD = '0a1b2c3d-0000-4000-8000-000000000002';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('serves the pinned ids, read on every request and never cached', async () => {
  vi.stubEnv('TOUR_PINS', JSON.stringify({ held: HELD }));

  const response = await GET();

  expect(response.status).toBe(200);
  expect(connection).toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ pins: { ...NO_PINS, held: HELD } });
});

it('serves empty pins when the setting is not there', async () => {
  vi.stubEnv('TOUR_PINS', '');
  expect(await (await GET()).json()).toEqual({ pins: NO_PINS });
});
