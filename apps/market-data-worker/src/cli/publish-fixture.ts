import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfig } from '../config.js';
import { PublicationConflictError } from '../errors.js';
import { DEFAULT_VECTOR_ROOT, loadSyntheticFixture } from '../fixture.js';
import { createUuidV7Generator } from '../ids.js';
import { publishDataset } from '../publication.js';
import { openStores } from '../runtime.js';

/**
 * `pnpm --filter @buoh/market-data-worker run fixture:publish`: publica los escenarios sintéticos
 * de `test-vectors/market-data/v1` en el stack local para poder ejercitar `data:replay`. Es una
 * acción explícita (ADR-0004 §13) y solo usa datos sintéticos. Reloj y entropía reales: aquí sí se
 * crean una publicación física nueva y su `publication_id`.
 */
async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const fixture = await loadSyntheticFixture(fileURLToPath(DEFAULT_VECTOR_ROOT));
  const nextId = createUuidV7Generator({ now: () => Date.now(), randomBytes });
  const stores = openStores(config);
  try {
    const results = [];
    for (const scenario of fixture.scenarios) {
      try {
        const publication = await publishDataset({
          environment: config.environment,
          metadata: stores.metadata,
          objects: stores.objects,
          profile: fixture.profile,
          publication_id: nextId(),
          published_at_utc: new Date().toISOString(),
          segments: scenario.segments,
          zlibVersion: process.versions.zlib,
        });
        results.push({
          dataset_id: publication.dataset_id,
          publication_id: publication.record.publication_id,
          scenario: scenario.name,
          status: 'published',
        });
      } catch (error) {
        if (!(error instanceof PublicationConflictError)) {
          throw error;
        }
        results.push({
          dataset_id: error.datasetId,
          scenario: scenario.name,
          status: 'already_published',
        });
      }
    }
    console.log(JSON.stringify({ deployment_environment: config.environment, results }));
    return 0;
  } finally {
    await stores.close();
  }
}

process.exitCode = await main();
