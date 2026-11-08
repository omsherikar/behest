import { connection } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/llms.txt/route';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.stubEnv('APP_URL', 'https://behest.example');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('serves the text as plain text that clients may keep for five minutes', async () => {
  const response = await GET();

  expect(response.status).toBe(200);
  expect(connection).toHaveBeenCalled();
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  const body = await response.text();
  expect(body.startsWith('# Behest\n')).toBe(true);
  expect(body).toContain('(https://behest.example/.well-known/jwks.json)');
});

it('names the repository documents by path while the repository is private', async () => {
  const body = await (await GET()).text();
  expect(body).toContain('- Architecture: `docs/architecture.md` in the repository, which is private for now.');
});

it('fails rather than link to a wrong origin when APP_URL is not set', async () => {
  vi.stubEnv('APP_URL', '');
  await expect(GET()).rejects.toThrow('APP_URL');
});
