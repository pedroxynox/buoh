/**
 * Lo que leen del sistema de datos la API (F2.4) y el motor (F2.9), por la ruta de exportación
 * `@buoh/market-data-worker/lectura` (ADR-0019 §8): la configuración y los pools, la búsqueda del
 * log activo, el log y sus puntos de control, el gráfico de una ventana, el perfil de medición, la
 * salud que guardó `buoh-operaciones`, el catálogo, los eventos de datos de un log, el registro
 * operativo, las publicaciones y el replay, y los almacenes en memoria para las pruebas.
 *
 * A diferencia del punto de entrada principal (`index.ts`), importarla no carga `ws`, `fflate` ni
 * `node:child_process`, que solo usan la captura, la carga de los esquemas de Deriv y
 * `buoh-operaciones`. `test/lectura.test.ts` lo comprueba sobre el JavaScript compilado, así que lo
 * que se añada aquí tampoco puede cargarlos. No exporta lo que solo escribe: el escritor de los
 * puntos de control, la publicación, las migraciones, los roles ni el bloqueo de la fuente. Algunas
 * clases que exporta también escriben, como `SourceEventLog`: lo que deja a la API y al motor en
 * solo lectura son sus credenciales, `buoh_api_lectura` y el token `api` de R2.
 */

// La configuración y los pools.
export {
  ConfigError,
  isDeployedEnvironment,
  loadConfig,
  POSTGRES_SSL_MODES,
  type PostgresSslMode,
  type WorkerConfig,
} from './config.js';
export { createPool, postgresSslOption, type PoolTimeouts } from './postgres/metadata-store.js';
export { openStores, type OpenStoresOptions } from './runtime.js';
export { createS3Client, S3ObjectStore, type S3Timeouts } from './s3/object-store.js';
export type { MetadataStore, ObjectStore } from './ports.js';

// La búsqueda del log activo (ADR-0018 §6).
export { locateActiveLog } from './runtime.js';
export {
  findActiveLog,
  isLogExpired,
  listCaptureLogs,
  LOG_RETENTION_MS,
  logLocation,
  logNumberOf,
  MAX_LOG_NUMBER,
  productionLogConfigErrors,
  readCaptureLog,
  selectActiveLog,
  withLog,
  type CaptureLog,
  type LogLocation,
} from './successive-logs.js';

// El log y sus puntos de control (ADR-0017 §4).
export {
  failureReason,
  LogIntegrityError,
  LogNotDerivableError,
  LogReadError,
  SourceEventLog,
  type OpenSourceEventLogInput,
} from './source-log/source-event-log.js';
export {
  PostgresSourceLogStore,
  type PostgresSourceLogStoreOptions,
} from './postgres/source-log-store.js';
export type {
  ClosedSegmentFinder,
  ClosedSourceSegment,
  LiveCheckpointBinding,
  SourceEventIndexRow,
  SourceLogState,
  SourceLogStore,
  StoredLiveCheckpoint,
} from './source-log/ports.js';
export {
  checkStoredCheckpoint,
  LiveCheckpointLookup,
  liveCheckpointVersionsSha256,
  type CheckedLiveCheckpoint,
  type LiveCheckpointBase,
  type LiveCheckpointFailure,
  type LiveCheckpointLookupInput,
  type LiveCheckpointRejection,
} from './source-log/live-checkpoint.js';
export {
  liveWatermark,
  readLiveState,
  readPreviousConnection,
  readSinceCheckpoint,
} from './source-log/live-reader.js';
export { previousConnection, type PreviousConnection } from './source-log/previous-connection.js';
export {
  checkFoldedContent,
  foldSinceCheckpoint,
  type CheckedFold,
  type FoldedContentCheck,
} from './deriv/log-check.js';
export { contentKey, keyFromUri, manifestKey, objectUri } from './object-keys.js';
export { ObjectReadError } from './errors.js';

// El gráfico de una ventana: los ticks y los huecos del log, desde sus puntos de control (ADR-0019 §8).
export {
  assembleChartWindow,
  CHART_FOLD_LIMIT,
  CHART_SEGMENT_MARGIN_MS,
  chartBoundaryOf,
  ChartCheckpointError,
  chartItemsOf,
  chartSegmentKey,
  readChartWindow,
  type ChartBoundary,
  type ChartGap,
  type ChartItem,
  type ChartSegmentCache,
  type ChartWindow,
  type ReadChartWindowInput,
} from './source-log/chart-window.js';

// El perfil de medición, armado con el esquema de fuente que guardó la ingesta (ADR-0015 §7 y §8).
export {
  createDerivMeasurementProfileFromSourceSchema,
  DERIV_CONNECTOR_VERSION,
  DERIV_NON_TICK_MSG_TYPES,
  DERIV_SOURCE,
} from './deriv/profile.js';
export {
  DERIV_OPERATIONS,
  DERIV_SCHEMA_RELEASE,
  schemaEntryName,
  SOURCE_SCHEMA_ENTRY,
  type DerivOperation,
  type ExpectedSchemaArchive,
  type SchemaEntryName,
  type SchemaKind,
} from './deriv/schema-release.js';
// El perfil de cada log, desde su fila de `log_quality_profile` (ADR-0020 §4).
export {
  createDerivLogProfile,
  LogProfileUnknownError,
  type LogQualityProfileRow,
} from './deriv/log-profile.js';
export { readLogQualityProfile } from './postgres/log-profile.js';
export {
  readStoredSourceSchema,
  SOURCE_SCHEMA_MAX_BYTES,
  type StoredSourceSchema,
} from './deriv/stored-source-schema.js';

// La salud de los datos: la última observación que guardó `buoh-operaciones` en un log (ADR-0019 §8).
export {
  parseStoredHealthObservation,
  readLatestStoredHealth,
  StoredHealthError,
  type StoredHealthAlert,
  type StoredHealthObservation,
  type StoredHealthRow,
} from './operations/stored-health.js';

// El catálogo (ADR-0012 §7).
export { PostgresCatalogStore } from './postgres/catalog-store.js';
export type { CatalogStore, CatalogVersion } from './deriv/ports.js';

// Los eventos de datos de un log y las publicaciones de `buoh_datasets`, para la sección Auditoría
// (ADR-0019 §5 y §8; ADR-0020 §10).
export {
  DataEventIntegrityError,
  readDatasetPublications,
  readLogDataEvents,
  type LogDataEvents,
  type ReadDatasetPublicationsInput,
  type ReadLogDataEventsInput,
  type StoredCatalogVersion,
  type StoredDataIncident,
  type StoredPublication,
} from './postgres/data-events.js';

// El registro operativo.
export {
  OperationalRegistry,
  stderrAlert,
  type OperationalAlert,
  type OperationalStore,
} from './operational/registry.js';
export { PostgresOperationalStore } from './postgres/operational-store.js';

// Las publicaciones y el replay (ADR-0004 §8 y §9).
export { PostgresMetadataStore } from './postgres/metadata-store.js';
export {
  MAX_MANIFEST_DOCUMENT_BYTES,
  MAX_REPLAY_OBJECT_BYTES,
  replayDataset,
  type ReplayInput,
  type ReplayMode,
  type ReplayReport,
} from './replay.js';
export { ReplayError, type ReplayErrorCode } from './errors.js';

// Los almacenes en memoria, para las pruebas de quien lee.
export {
  InMemoryCatalogStore,
  InMemoryObjectStore,
  InMemoryOperationalStore,
  InMemorySourceLogStore,
} from './memory/stores.js';
