import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { WORKER_NODE_FLAGS } from '../src/index.js';

// Los tamaños de V8 de los procesos del worker que leen el log (ADR-0017 §9): el script `ingest`
// del paquete corre con ellos, y `scripts/data-health.mjs` los pasa a la CLI de salud (su prueba está
// en `scripts/data-health.test.mjs`).

describe('WORKER_NODE_FLAGS (ADR-0017 §9)', () => {
  it('fija los tamaños que Node elige con 512 MiB: semiespacios de 1 MiB y 256 MiB de generación vieja', () => {
    expect(WORKER_NODE_FLAGS).toEqual(['--max-semi-space-size=1', '--max-old-space-size=256']);
  });

  it('el script ingest del paquete corre la CLI con esos límites', () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(scripts['ingest']).toBe(`node ${WORKER_NODE_FLAGS.join(' ')} dist/cli/ingest.js`);
  });
});
