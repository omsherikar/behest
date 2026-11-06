import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The first createTestDb() in a file migrates a fresh PGlite database. With several such files
    // running in parallel on a busy machine that can take far longer than the 5 second default,
    // in a test or in a beforeAll hook alike.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
