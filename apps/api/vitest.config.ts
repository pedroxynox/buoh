import { defineConfig } from 'vitest/config';

// Suite offline: Fastify con `inject` y conexiones en memoria, sin abrir puertos, sin red, reloj
// real ni aleatoriedad.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
  },
});
