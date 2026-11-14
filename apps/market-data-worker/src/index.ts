export {
  ConfigError,
  DEFAULT_POSTGRES_SCHEMA,
  DEFAULT_S3_BUCKET,
  isDeployedEnvironment,
  loadConfig,
  loadPostgresConfig,
  POSTGRES_IDENTIFIER,
  POSTGRES_SSL_MODES,
  type PostgresSslMode,
  type PostgresWorkerConfig,
  type WorkerConfig,
} from './config.js';
export { migrateCommand, type MigrateCommandDeps, type MigratePool } from './migrate-command.js';
export {
  createStorageEncoder,
  decodeObject,
  GZIP_WRITER_NAME,
  MAX_SOURCE_SEGMENT_BYTES,
} from './encoding.js';
export {
  CommitOutcomeUnknownError,
  ObjectReadError,
  PublicationConflictError,
  PublicationError,
  PublicationLimitError,
  ReplayError,
  type PublicationLimit,
  type PublicationStep,
  type ReplayErrorCode,
} from './errors.js';
export { loadSyntheticFixture, type FixtureScenario, type SyntheticFixture } from './fixture.js';
export { createUuidV7Generator } from './ids.js';
export { WORKER_NODE_FLAGS } from './node-flags.js';
export {
  buildRawSourceFrame,
  RawFirstIngestor,
  type CloseRepairOutcome,
  type FrameInput,
  type PersistenceFailureReport,
  type RawFirstIngestorInput,
  type ReceiveOutcome,
  type TickSink,
} from './ingestion/raw-first-ingestor.js';
export {
  INGESTION_CURSOR_SCHEMA_VERSION,
  ingestionHeartbeatSchema,
  parseIngestionCursor,
  type IngestionCursorVersion,
  type IngestionHeartbeat,
  type IngestionStatusStore,
} from './ingestion/status.js';
export {
  OPERATIONAL_RESOLUTION_REASONS,
  OperationalRegistry,
  stderrAlert,
  type OperationalAlert,
  type OperationalStore,
  type PersistenceStage,
  type RecordResult,
} from './operational/registry.js';
export { PostgresCatalogStore } from './postgres/catalog-store.js';
export { PostgresOperationalStore } from './postgres/operational-store.js';
export { PostgresRequestedResponseIncidentStore } from './postgres/requested-response-store.js';
export { PostgresIngestionStatusStore } from './postgres/ingestion-status-store.js';
export { openLockedSourceLog, PostgresSessionLockProvider } from './postgres/session-lock.js';
export {
  lockedSourceLogStore,
  SOURCE_LOCK_HEARTBEAT_MS,
  SOURCE_LOCK_LOST,
  SOURCE_LOCK_QUERY_TIMEOUT_MS,
  SourceLock,
  sourceLockKey,
} from './postgres/source-lock.js';
export { PostgresSourceLogStore } from './postgres/source-log-store.js';
export {
  type ClosedSourceSegment,
  type LiveCheckpointBinding,
  type LiveCheckpointCandidate,
  type LiveCheckpointInsert,
  type SourceEventIndexRow,
  type SourceLogState,
  type SourceLogStore,
  type StoredLiveCheckpoint,
} from './source-log/ports.js';
export {
  checkpointRow,
  checkStoredCheckpoint,
  LiveCheckpointLookup,
  LiveCheckpointWriter,
  liveCheckpointVersionsSha256,
  type CheckedLiveCheckpoint,
  type LiveCheckpointBase,
  type LiveCheckpointFailure,
  type LiveCheckpointLookupInput,
  type LiveCheckpointRejection,
  type LiveCheckpointWriterInput,
} from './source-log/live-checkpoint.js';
export {
  liveWatermark,
  readLiveState,
  readPreviousConnection,
  readSinceCheckpoint,
} from './source-log/live-reader.js';
export { previousConnection, type PreviousConnection } from './source-log/previous-connection.js';
export { publishFromLog, type PublishFromLogInput } from './source-log/publish-from-log.js';
export {
  failureReason,
  LogIntegrityError,
  LogNotDerivableError,
  LogPersistenceError,
  LogReadError,
  SourceEventLog,
  writeVerified,
  type LogStage,
  type OpenSourceEventLogInput,
} from './source-log/source-event-log.js';
export { driveSyntheticStimuli, type SyntheticDriverHooks } from './synthetic-driver.js';
export { contentKey, keyFromUri, manifestKey, objectUri } from './object-keys.js';
export {
  type CommitPublicationInput,
  type DatasetLogRange,
  type DatasetStore,
  type MetadataStore,
  type ObjectStore,
  type PublishedDataset,
} from './ports.js';
export {
  DATASETS_MIGRATIONS,
  loadMigrations,
  LOG_MIGRATIONS,
  migrate,
  migrateDatasets,
  MigrationApplyError,
  MigrationIntegrityError,
  pendingMigrations,
  type MigrateOptions,
  type MigrationSequence,
} from './postgres/migrate.js';
export { DATASETS_PREFIX, DATASETS_SCHEMA } from './datasets/location.js';
export { createPool, PostgresMetadataStore, postgresSslOption } from './postgres/metadata-store.js';
export {
  AGENT_CONNECTION_LIMIT,
  API_READER_ROLE,
  API_ROLE,
  API_SCHEMA,
  AGENT_IDLE_IN_TRANSACTION_TIMEOUT,
  AGENT_STATEMENT_TIMEOUT,
  DATASETS_OWNER_TABLES,
  DATASETS_PUBLICATION_TABLES,
  ensureApiReaderRole,
  ensureApiRole,
  ensurePublicationRole,
  ensureRuntimeRoles,
  grantApiPrivileges,
  grantDatasetsPrivileges,
  grantLogPrivileges,
  INGEST_DENIED_TABLES,
  INGEST_WRITE_TABLES,
  LOGIN_ROLES,
  MIGRATIONS_TABLE,
  MIN_ROLE_PASSWORD_LENGTH,
  POSTGRES_ROLES,
  PUBLICATION_ROLE,
  SCRAM_ITERATIONS,
  scramSha256Verifier,
  setRolePassword,
  UnclassifiedTableError,
  type LoginRole,
  type PasswordRole,
} from './postgres/roles.js';
export {
  preparePublication,
  publishDataset,
  writePublication,
  type PublishDatasetInput,
} from './publication.js';
export {
  DATASET_WRITE_CONCURRENCY,
  publishLiveDataset,
  type PublishLiveDatasetInput,
  type PublishLiveOutcome,
} from './datasets/publish-live.js';
export { PostgresDatasetStore } from './postgres/dataset-store.js';
export {
  logReader,
  PUBLICATION_BEHIND_MS,
  publicationFailure,
  publishDatasetCommand,
  PUBLISH_USAGE,
  type PublicationFailureReason,
  type PublicationLogReader,
  type PublicationStores,
  type PublishCommandDependencies,
} from './datasets/publish-command.js';
export { openPublicationStores } from './datasets/publication-stores.js';
export {
  replayCommand,
  type ReplayCommandDependencies,
  type ReplayCommandStores,
} from './replay-command.js';
export {
  DATASET_ELEMENT_CEILING,
  DATASET_END_STEP_SEGMENTS,
  planDataset,
  type DatasetOpenState,
  type DatasetPlan,
  type PlanDatasetInput,
  type PlanSegment,
} from './datasets/plan.js';
export {
  MAX_MANIFEST_DOCUMENT_BYTES,
  MAX_REPLAY_OBJECT_BYTES,
  REPLAY_READ_LIMITS,
  replayDataset,
  type ReplayReadLimits,
  type ReplayInput,
  type ReplayMode,
  type ReplayReport,
} from './replay.js';
export { parseReplayArgs, REPLAY_USAGE, UsageError } from './replay-args.js';
export {
  InMemoryCatalogStore,
  InMemoryIngestionStatusStore,
  InMemoryObjectStore,
  InMemoryOperationalStore,
  InMemoryRequestedResponseIncidentStore,
  InMemorySourceLogStore,
} from './memory/stores.js';
export {
  DERIV_TIME_RESOLUTION_MS,
  distribution,
  lastDurableRecovery,
  runSmoke,
  smokeCommand,
  smokeExitCode,
  SMOKE_NOTE,
  type Distribution,
  type SmokeInput,
  type SmokeRecovery,
  type SmokeReport,
} from './smoke.js';
export {
  parseSmokeArgs,
  SMOKE_DEFAULT_DURATION_SECONDS,
  SMOKE_DEFAULT_SYMBOL,
  SMOKE_MAX_DURATION_SECONDS,
  SMOKE_USAGE,
  symbolOption,
  type SmokeOptions,
} from './smoke-args.js';
export {
  checkIngestConfig,
  IngestConfigError,
  INGEST_USAGE,
  parseIngestArgs,
  type IngestOptions,
} from './ingest-args.js';
export {
  INGEST_RETENTION_MS,
  ingestCommand,
  ingestExitCode,
  runIngest,
  WAIT_STOPPED,
  type IngestDependencies,
  type IngestInput,
  type IngestRecovery,
  type IngestReport,
  type IngestStores,
} from './ingest.js';
export {
  HandedOverLockProvider,
  STARTUP_ALERT_INTERVAL_MS,
  STARTUP_LOCK_RETRY_MS,
  STARTUP_RETRY_MS,
  STARTUP_WAIT_REASONS,
  waitForProductionStart,
  type StartupReads,
  type StartupWaitInput,
  type StartupWaitReason,
  type StartupWaitResult,
} from './ingest-startup.js';
export {
  evaluateDataHealth,
  type HealthAlert,
  type HealthEvaluation,
  type HealthObservation,
  type ObservedSource,
} from './health/evaluate.js';
export {
  observeDataHealth,
  type HealthStores,
  type ObserveDataHealthInput,
} from './health/observe.js';
export {
  HEALTH_CLOSE_DEADLINE_MS,
  HEALTH_DEADLINE_MS,
  healthCommand,
  LOG_NOT_PREPARED,
  type HealthCommandResult,
  type HealthCommandStores,
  type HealthDependencies,
} from './health/command.js';
export { HEALTH_USAGE, parseHealthArgs, type HealthOptions } from './health-args.js';
export {
  HEALTH_CONNECTION_TIMEOUT_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  locateActiveLog,
  openStartupReads,
  openHealthStores,
  openStores,
  type OpenStoresOptions,
} from './runtime.js';
export { createS3Client, isObjectLocked, S3ObjectStore } from './s3/object-store.js';
export {
  CHILD_OUTPUT_LIMIT_BYTES,
  CHILD_TIMEOUT_MS,
  runNodeScript,
  runWorkerChild,
  workerChildScript,
  type ChildResult,
  type RunChild,
  type WorkerChild,
} from './operations/child.js';
export {
  apiMigrateEnvironment,
  healthEnvironment,
  loadOperationsConfig,
  CODE_VERSION,
  migrateEnvironment,
  publishEnvironment,
  replayEnvironment,
  type OperationsConfig,
} from './operations/config.js';
export {
  DATASET_VERIFICATION_STEP,
  DATASETS_START_LIMIT_MS,
  DATASETS_STEP_DEADLINE_MS,
  datasetVerificationStep,
  INCONCLUSIVE_RUNS,
  PUBLICATION_STEP,
  PUBLICATION_STOP_REASONS,
  publicationStep,
} from './operations/datasets-steps.js';
export {
  parseStoredHealthObservation,
  readLatestStoredHealth,
  StoredHealthError,
  type StoredHealthAlert,
  type StoredHealthObservation,
  type StoredHealthRow,
} from './operations/stored-health.js';
export {
  DROP_LOG_LOCK_TIMEOUT_MS,
  OPERATIONS_CONNECTION_TIMEOUT_MS,
  OPERATIONS_QUERY_TIMEOUT_MS,
  openOwnerDatabase,
  type LoginCheck,
  type LogSchemaDrop,
  type OperationsReportRow,
  type DatasetVerificationRow,
  type OwnerDatabase,
  type PublicationToVerify,
  type StoredReport,
  type SpaceMeasure,
} from './operations/owner-database.js';
export {
  deleteKeys,
  ListingOutsidePrefixError,
  logDeletion,
  openLogDeletion,
  RETENTION_CONCURRENCY,
  RETENTION_DEADLINE_MS,
  RETENTION_PAGE_KEYS,
  type DeletionProgress,
  type LogDeletion,
  type ObjectDeletion,
} from './operations/retention.js';
export {
  nextLogToPrepare,
  OPERATIONS_STEPS,
  operationsCommand,
  runOperations,
  type OperationsDependencies,
  type OperationsInput,
  type OperationsRun,
  type OperationsStep,
} from './operations/run.js';
export {
  openLogObjects,
  VERIFICATION_DEADLINE_MS,
  VERIFICATION_SLOTS,
  verificationSlot,
  verifySegment,
  type DueSegment,
  type LogObjects,
  type SegmentMismatch,
} from './operations/verification.js';
export {
  cutTimeOf,
  isCleanForCut,
  locateCaptureLog,
  LockRetention,
  LOG_CUT_ALERT_INTERVAL_MS,
  LOG_CUT_CHECK_MS,
  LOG_CUT_FORCE_AFTER_MS,
  LogCutWatch,
  type CaptureTarget,
  type LogCutDecision,
  type LogCutReads,
  type LogCutSession,
  type LogCutWatchInput,
  type LogReadiness,
} from './log-cut.js';
export {
  findActiveLog,
  firstWriteOf,
  isLogExpired,
  listCaptureLogs,
  LOG_NUMBER_DIGITS,
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
