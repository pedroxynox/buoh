import { type WorkerConfig } from './config.js';
import { type HealthCommandStores } from './health/command.js';
import { type StartupReads } from './ingest-startup.js';
import { stderrAlert, type OperationalAlert } from './operational/registry.js';
import { PostgresCatalogStore } from './postgres/catalog-store.js';
import { PostgresIngestionStatusStore } from './postgres/ingestion-status-store.js';
import { PostgresMetadataStore, createPool } from './postgres/metadata-store.js';
import { pendingMigrations } from './postgres/migrate.js';
import { PostgresOperationalStore } from './postgres/operational-store.js';
import { PostgresRequestedResponseIncidentStore } from './postgres/requested-response-store.js';
import { sourceLockHolder } from './postgres/source-lock.js';
import { PostgresSourceLogStore } from './postgres/source-log-store.js';
import { S3ObjectStore } from './s3/object-store.js';
import { failureReason } from './source-log/source-event-log.js';
import { findActiveLog, readCaptureLog, type LogLocation } from './successive-logs.js';

export interface OpenStoresOptions {
  /** Alerta saneada, en stderr por defecto. */
  readonly alert?: OperationalAlert;
  /**
   * Los plazos de cada conexión y de cada consulta o petición, en milisegundos, en PostgreSQL y en
   * el almacenamiento de objetos. Sin ellos ninguna tiene plazo, como en `ingest`, `data:replay` y
   * `fixture:publish`.
   */
  readonly timeouts?: { readonly connectionMs: number; readonly requestMs: number };
}

/**
 * El plazo de cada conexión de `data:health` a PostgreSQL o al almacenamiento de objetos, el mismo
 * que el de `SourceLock` (ADR-0015 §8, regla 3).
 */
export const HEALTH_CONNECTION_TIMEOUT_MS = 5_000;
/** El plazo de cada consulta a PostgreSQL y de cada petición al almacenamiento de `data:health`. */
export const HEALTH_REQUEST_TIMEOUT_MS = 10_000;

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
  const { timeouts } = options;
  const pool = createPool(
    config.postgres,
    timeouts === undefined
      ? undefined
      : { connectionTimeoutMillis: timeouts.connectionMs, query_timeout: timeouts.requestMs },
  );
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });
  const objects = S3ObjectStore.fromConfig(
    config.s3,
    timeouts === undefined
      ? undefined
      : { connectionTimeout: timeouts.connectionMs, requestTimeout: timeouts.requestMs },
  );
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

/**
 * Las lecturas de `data:health` (ADR-0015 §8) sobre `openStores`, con su pool y su alerta: el log,
 * el esquema de fuente guardado, el registro operativo, el cursor y el latido, el último dataset,
 * el escritor vivo según `pg_locks` (`sourceLockHolder`) y las migraciones pendientes. Ninguna
 * escribe ni toma el bloqueo. `close` libera las conexiones.
 *
 * Cada lectura tiene plazo, para que un almacén que acepta la conexión y no contesta termine en la
 * regla 3: cada conexión, `HEALTH_CONNECTION_TIMEOUT_MS`, y cada consulta o petición,
 * `HEALTH_REQUEST_TIMEOUT_MS`. Una lectura vencida falla como cualquier otra, con su código o su
 * nombre (`failureReason`). El plazo total es el de `healthCommand`.
 */
export function openHealthStores(
  config: WorkerConfig,
  options: Pick<OpenStoresOptions, 'alert'> = {},
): HealthCommandStores {
  const stores = openStores(config, {
    ...options,
    timeouts: { connectionMs: HEALTH_CONNECTION_TIMEOUT_MS, requestMs: HEALTH_REQUEST_TIMEOUT_MS },
  });
  return {
    close: stores.close,
    datasets: stores.metadata,
    ingestionStatus: stores.ingestionStatus,
    lockHolder: (source) => sourceLockHolder(stores.pool, source),
    objects: stores.objects,
    operational: stores.operational,
    pendingMigrations: () => pendingMigrations(stores.pool),
    sourceLog: stores.sourceLog,
  };
}

/**
 * Las lecturas de la espera del arranque de `ingest` en `production` (ADR-0018 §4), sobre un pool
 * propio con la credencial de la configuración y los mismos plazos de cada conexión y de cada
 * consulta que `data:health`, para que un PostgreSQL que acepta la conexión y no contesta no deje
 * la espera parada: el log activo de `source` (`findActiveLog`) y las migraciones que le faltan
 * (`pendingMigrations` con su esquema). Ninguna escribe nada. Si PostgreSQL cierra una conexión
 * libre del pool, deja la alerta `postgres_connection_lost`, como `openStores`. `close` libera las
 * conexiones.
 */
export function openStartupReads(
  config: WorkerConfig,
  input: Pick<OpenStoresOptions, 'alert'> & {
    readonly now: () => string;
    readonly source: string;
  },
): StartupReads {
  const alert = input.alert ?? stderrAlert;
  const pool = createPool(config.postgres, {
    connectionTimeoutMillis: HEALTH_CONNECTION_TIMEOUT_MS,
    query_timeout: HEALTH_REQUEST_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });
  return {
    close: () => pool.end(),
    locateLog: () => findActiveLog(pool, { now: input.now, source: input.source }),
    pendingMigrations: (log) => pendingMigrations(pool, log.schema),
  };
}

/**
 * El log que observa `data:health` en `production` (ADR-0018 §6): el log activo de `source`, o,
 * con `number`, ese log si existe y se puede leer (`--log`; ADR-0018 §11), vencido o no. Abre un
 * pool propio con los plazos de `openHealthStores` y la credencial de la configuración, busca el log
 * (`findActiveLog` o `readCaptureLog`) sin escribir nada y lo cierra. Si PostgreSQL cierra una
 * conexión libre del pool, deja la alerta `postgres_connection_lost`, como `openStores`. Rechaza
 * con el error de la lectura si PostgreSQL no responde.
 */
export async function locateActiveLog(
  config: WorkerConfig,
  input: Pick<OpenStoresOptions, 'alert'> & {
    readonly now: () => string;
    /** El log pedido, o `null` o sin él para el log activo. */
    readonly number?: number | null;
    readonly source: string;
  },
): Promise<LogLocation | null> {
  const alert = input.alert ?? stderrAlert;
  const pool = createPool(config.postgres, {
    connectionTimeoutMillis: HEALTH_CONNECTION_TIMEOUT_MS,
    query_timeout: HEALTH_REQUEST_TIMEOUT_MS,
  });
  pool.on('error', (error) => {
    alert({ event: 'postgres_connection_lost', reason: failureReason(error) });
  });
  try {
    if (input.number === undefined || input.number === null) {
      return await findActiveLog(pool, { now: input.now, source: input.source });
    }
    const log = await readCaptureLog(pool, { number: input.number, source: input.source });
    return log?.readable === true ? log.location : null;
  } finally {
    await pool.end();
  }
}
