import { defineConfig } from 'vitest/config';

// Integración contra el PostgreSQL local (infra/compose.yaml): `db:migrate` de la API, su tabla y su
// cifrado. Sin las guardas de determinismo de test/setup.ts: las contraseñas de prueba son
// aleatorias.
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ['integration/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
