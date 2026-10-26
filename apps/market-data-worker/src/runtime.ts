import { type WorkerConfig } from './config.js';
import { PostgresCatalogStore } from './postgres/catalog-store.js';
import { PostgresMetadataStore, createPool } from './postgres/metadata-store.js';
import { PostgresOperationalStore } from './postgres/operational-store.js';
import { PostgresRequestedResponseIncidentStore } from './postgres/requested-response-store.js';
import { PostgresSourceLogStore } from './postgres/source-log-store.js';
import { S3ObjectStore } from './s3/object-store.js';

/** Conecta los adaptadores reales configurados; `close` libera conexiones. */
export function openStores(config: WorkerConfig) {
  const pool = createPool(config.postgres);
  const objects = S3ObjectStore.fromConfig(config.s3);
  return {
    catalog: new PostgresCatalogStore(pool, objects),
    close: async () => {
      objects.destroy();
      await pool.end();
    },
    metadata: new PostgresMetadataStore(pool),
    objects,
    operational: new PostgresOperationalStore(pool),
    pool,
    requestedResponses: new PostgresRequestedResponseIncidentStore(pool),
    sourceLog: new PostgresSourceLogStore(pool),
  };
}
