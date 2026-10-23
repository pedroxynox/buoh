import { type WorkerConfig } from './config.js';
import { PostgresMetadataStore, createPool } from './postgres/metadata-store.js';
import { S3ObjectStore } from './s3/object-store.js';

/** Conecta los adaptadores reales configurados; `close` libera conexiones. */
export function openStores(config: WorkerConfig) {
  const pool = createPool(config.postgres);
  const objects = S3ObjectStore.fromConfig(config.s3);
  return {
    close: async () => {
      objects.destroy();
      await pool.end();
    },
    metadata: new PostgresMetadataStore(pool),
    objects,
    pool,
  };
}
