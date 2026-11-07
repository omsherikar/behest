import { connection } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from '@/app/.well-known/jwks.json/route';
import { appJwks } from '@/lib/app-deps';
import { generateSigningKey, loadSigningKey, publicJwks } from '@/lib/receipts/keys';

// connection() needs a Next.js request scope, which a test does not have.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: vi.fn(async () => {}),
}));
vi.mock('@/lib/app-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/app-deps')>()),
  appJwks: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

it('serves the public key set, which clients may keep for five minutes', async () => {
  const jwks = publicJwks([await loadSigningKey({ RECEIPT_SIGNING_KEY: (await generateSigningKey()).pem })]);
  vi.mocked(appJwks).mockResolvedValue(jwks);

  const response = await GET();

  expect(response.status).toBe(200);
  expect(connection).toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  expect(await response.json()).toEqual(jwks);
});
