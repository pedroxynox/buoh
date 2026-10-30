import { describe } from 'vitest';

import { InMemorySourceLogStore } from '../src/index.js';
import { checkpointStoreRules } from './support/checkpoint-store-rules.js';

// Puntos de control del estado vivo en memoria (ADR-0017 §5 y §6), con las reglas de la migración
// `0005`. Las mismas pruebas corren contra PostgreSQL en integration/live-checkpoints.test.ts.
describe('InMemorySourceLogStore: puntos de control', () => {
  checkpointStoreRules(() => new InMemorySourceLogStore());
});
