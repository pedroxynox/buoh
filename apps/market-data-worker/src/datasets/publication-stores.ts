import type { WorkerConfig } from '../config.js';
import { DERIV_SOURCE } from '../deriv/profile.js';
import type { ExpectedSchemaArchive } from '../deriv/schema-release.js';
import { stderrAlert, type OperationalAlert } from '../operational/registry.js';
import { PostgresDatasetStore } from '../postgres/dataset-store.js';
import { createPool } from '../postgres/metadata-store.js';
import { PostgresOperationalStore } from '../postgres/operational-store.js';
import { PostgresSourceLogStore } from '../postgres/source-log-store.js';
import { HEALTH_CONNECTION_TIMEOUT_MS, HEALTH_REQUEST_TIMEOUT_MS } from '../runtime.js';
import { createS3Client, S3ObjectStore } from '../s3/object-store.js';
import { failureReason } from '../source-log/source-event-log.js';
import { listCaptureLogs } from '../successive-logs.js';
import { logReader, type PublicationStores } from './publish-command.js';

/**
 * Los almacenes reales de `datasets:publish` (ADR-0020 §5 y §8), con la configuración de
 * `buoh_datasets` (`loadPublishConfig`): un pool con ese esquema en su `search_path`, del que
 * cuelgan `buoh_datasets`, su registro operativo y las lecturas de cada log, que nombran sus tablas
 * con el esquema del log; y un solo cliente S3, con el bucket sin prefijo para los objetos de los
 * datasets y con el prefijo `logs/<n>/` para los de cada log. Cada conexión y cada consulta o
 * petición tienen los plazos de `data:health`. Si PostgreSQL cierra una conexión libre del pool,
 * deja la alerta `postgres_connection_lost`, como `openStores`.
 */
export function openPublicationStores(
  config: WorkerConfig,
  input: { readonly alert?: OperationalAlert; readonly schemas: ExpectedSchemaArchive },
): PublicationStores {
  const alert = input.alert ?? stderrAlert;
  const pool = createPool(config.postgres, {
    connectionTimeoutMillis: HEALTH_CONNECTION_TIMEOUT_MS,
    query_timeout: HEALTH_REQUEST_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });
  const s3 = createS3Client(config.s3, {
    connectionTimeout: HEALTH_CONNECTION_TIMEOUT_MS,
    requestTimeout: HEALTH_REQUEST_TIMEOUT_MS,
  });
  return {
    close: async () => {
      s3.destroy();
      await pool.end();
    },
    datasetObjects: new S3ObjectStore(s3, config.s3.bucket, ''),
    datasets: new PostgresDatasetStore(pool),
    listLogs: () => listCaptureLogs(pool, DERIV_SOURCE),
    log: (location) =>
      logReader({
        objects: new S3ObjectStore(s3, config.s3.bucket, location.prefix),
        schemas: input.schemas,
        source: DERIV_SOURCE,
        store: new PostgresSourceLogStore(pool, { schema: location.schema }),
      }),
    operational: new PostgresOperationalStore(pool),
  };
}
