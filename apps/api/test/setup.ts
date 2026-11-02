import type * as NodeCrypto from 'node:crypto';

import { vi } from 'vitest';

// La guarda de determinismo de `node:crypto` (ADR-0019 §13): el código de `src/` recibe sus
// identificadores y su azar inyectados, así que ninguna prueba puede llegar a una de estas
// funciones. Va en un archivo de preparación para valer en todos los módulos que cargan las
// pruebas. Las funciones deterministas, como los hashes, no cambian.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const forbidden = (name: string) => () => {
    throw new Error(`node:crypto ${name} no está permitido en las pruebas de la API.`);
  };
  const guarded = {
    getRandomValues: forbidden('getRandomValues'),
    randomBytes: forbidden('randomBytes'),
    randomFill: forbidden('randomFill'),
    randomFillSync: forbidden('randomFillSync'),
    randomInt: forbidden('randomInt'),
    randomUUID: forbidden('randomUUID'),
  };
  return { ...actual, ...guarded, default: { ...actual, ...guarded } };
});
