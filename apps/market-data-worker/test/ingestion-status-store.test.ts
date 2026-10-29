import { describe } from 'vitest';

import { InMemoryIngestionStatusStore } from '../src/index.js';
import { statusStoreRules } from './support/status-store-rules.js';

// Cursor y latido en memoria (ADR-0015 §6), con las reglas de la migración `0004`. Las mismas
// pruebas corren contra PostgreSQL en integration/ingestion-status.test.ts.
describe('InMemoryIngestionStatusStore', () => {
  statusStoreRules(() => new InMemoryIngestionStatusStore());
});
