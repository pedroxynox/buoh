import { defineConfig } from 'vitest/config';

// Suite offline: adaptadores en memoria, sin red, reloj real ni aleatoriedad.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
