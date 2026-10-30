import { describe } from 'vitest';

import { InMemorySourceLogStore } from '../src/index.js';
import { checkpointStoreRules, sourceEventLookupRules } from './support/checkpoint-store-rules.js';

// Puntos de control del estado vivo en memoria (ADR-0017 §5 y §6), con las reglas de la migración
// `0005`, y la búsqueda de un evento en el índice con la que el arranque comprueba el cursor (§4).
// Las mismas pruebas corren contra PostgreSQL en integration/live-checkpoints.test.ts.
describe('InMemorySourceLogStore: puntos de control', () => {
  checkpointStoreRules(() => new InMemorySourceLogStore());
});

describe('InMemorySourceLogStore: búsqueda de un evento en el índice', () => {
  sourceEventLookupRules(() => new InMemorySourceLogStore());
});
