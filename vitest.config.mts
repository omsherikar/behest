import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The first createTestDb() in a file migrates a fresh PGlite database. With several such files
    // running in parallel on a busy machine that can take longer than the 5 second default.
    testTimeout: 20_000,
  },
});
