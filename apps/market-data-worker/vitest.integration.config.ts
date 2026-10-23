import { defineConfig } from 'vitest/config';

// Integración contra PostgreSQL y almacenamiento S3-compatible locales (infra/compose.yaml).
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ['integration/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
