import { type WorkerConfig } from './config.js';
import { stderrAlert, type OperationalAlert } from './operational/registry.js';
import { PostgresCatalogStore } from './postgres/catalog-store.js';
import { PostgresIngestionStatusStore } from './postgres/ingestion-status-store.js';
import { PostgresMetadataStore, createPool } from './postgres/metadata-store.js';
import { PostgresOperationalStore } from './postgres/operational-store.js';
import { PostgresRequestedResponseIncidentStore } from './postgres/requested-response-store.js';
import { PostgresSourceLogStore } from './postgres/source-log-store.js';
import { S3ObjectStore } from './s3/object-store.js';
import { failureReason } from './source-log/source-event-log.js';

export interface OpenStoresOptions {
  /** Alerta saneada, en stderr por defecto. */
  readonly alert?: OperationalAlert;
}

/**
 * Conecta los adaptadores reales configurados; `close` libera conexiones.
 *
 * Si PostgreSQL cierra una conexión libre del pool (un reinicio, `pg_terminate_backend` o un corte
 * de red), el pool la descarta y emite `error`. Sin quien lo escuche, Node cerraría el proceso y
 * escribiría en stderr el error entero, con el mensaje del servidor y los campos de la conexión.
 * Aquí deja una sola alerta, `postgres_connection_lost`, con el código o el nombre del error
 * (`failureReason`) y nada más. La consulta siguiente abre otra conexión, y si falla, falla como
 * cualquier consulta, con los reintentos de quien la hizo.
 */
export function openStores(config: WorkerConfig, options: OpenStoresOptions = {}) {
  const alert = options.alert ?? stderrAlert;
  const pool = createPool(config.postgres);
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });
  const objects = S3ObjectStore.fromConfig(config.s3);
  return {
    catalog: new PostgresCatalogStore(pool, objects),
    close: async () => {
      objects.destroy();
      await pool.end();
    },
    ingestionStatus: new PostgresIngestionStatusStore(pool),
    metadata: new PostgresMetadataStore(pool),
    objects,
    operational: new PostgresOperationalStore(pool),
    pool,
    requestedResponses: new PostgresRequestedResponseIncidentStore(pool),
    sourceLog: new PostgresSourceLogStore(pool),
  };
}
