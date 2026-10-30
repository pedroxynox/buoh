import { type HistoryRecoveryResult } from '@buoh/contracts';

import { ConfigError, loadConfig, type WorkerConfig } from './config.js';
import { type DerivSchemaSummary } from './deriv/adapter.js';
import { type HistoryRecoveryOutcome } from './deriv/history-recovery.js';
import {
  type CatalogStore,
  type RequestedResponseIncidentStore,
  type Scheduler,
} from './deriv/ports.js';
import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from './deriv/profile.js';
import { type ExpectedSchemaArchive } from './deriv/schema-archive.js';
import {
  startDerivSession,
  type DerivSessionConnection,
  type DerivSessionResult,
  type SessionLock,
  type SessionLockProvider,
} from './deriv/session.js';
import { type SocketFactory } from './deriv/socket.js';
import { checkIngestConfig, IngestConfigError, parseIngestArgs } from './ingest-args.js';
import { type IngestionStatusStore } from './ingestion/status.js';
import {
  OperationalRegistry,
  type OperationalAlert,
  type OperationalStore,
} from './operational/registry.js';
import { type ObjectStore } from './ports.js';
import { UsageError } from './replay-args.js';
import { type SourceLogStore } from './source-log/ports.js';
import {
  failureReason,
  type OpenSourceEventLogInput,
  type SourceEventLog,
} from './source-log/source-event-log.js';

/** La retención de la captura viva: 23 horas, una antes del borrado a las 24 (ADR-0015 §7). */
export const INGEST_RETENTION_MS = 23 * 3_600_000;

/**
 * Los almacenes de la captura, abiertos con su configuración: PostgreSQL y el almacenamiento de
 * objetos en `ingest` (`openStores`). El log, el catálogo, las respuestas pedidas, el registro
 * operativo, el cursor y el latido viven en el esquema y el bucket propios de la captura.
 */
export interface IngestStores {
  readonly catalog: CatalogStore;
  readonly ingestionStatus: IngestionStatusStore;
  readonly objects: ObjectStore;
  readonly operational: OperationalStore;
  readonly requestedResponses: RequestedResponseIncidentStore;
  readonly sourceLog: SourceLogStore;
  /** Las migraciones del worker que el esquema todavía no tiene, sin aplicar nada. */
  pendingMigrations(): Promise<readonly string[]>;
  /** Libera las conexiones. */
  close(): Promise<void>;
}

/**
 * Lo que necesita la captura además de sus almacenes ya abiertos: los puertos de la sesión, el
 * bloqueo de la fuente, la apertura del log con él y las señales de parada.
 */
export interface IngestInput {
  /** Alerta saneada, en stderr por defecto. */
  readonly alert?: OperationalAlert;
  readonly connect: SocketFactory;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  /** El bloqueo de la fuente: `PostgresSessionLockProvider` en `ingest`. */
  readonly lock: SessionLockProvider;
  readonly nextId: () => string;
  readonly now: () => string;
  /** Abre el log con el almacén protegido por ese bloqueo: `openLockedSourceLog` en `ingest`. */
  readonly openLog: (lock: SessionLock) => Promise<SourceEventLog>;
  /** Azar de la espera entre intentos, en [0, 1). */
  readonly random: () => number;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
  /**
   * Escucha las señales de parada (`SIGINT` y `SIGTERM` en `ingest`): llama a `onSignal` con cada
   * una y devuelve la función que deja de escucharlas.
   */
  readonly signals: (onSignal: () => void) => () => void;
  readonly stores: Omit<IngestStores, 'close' | 'pendingMigrations'>;
  readonly symbol: string;
}

/** Una recuperación de historia en el resultado de `ingest`: sin horas ni precios. */
export interface IngestRecovery {
  /** Intentos hechos, de 1 a 3; `null` si se abandonó. */
  readonly attempts: number | null;
  /** Si su `HistoryRecoveryResult` quedó en el log. Una abandonada nunca queda. */
  readonly durable: boolean;
  /** Páginas pedidas en el último intento; `null` si se abandonó. */
  readonly pages: number | null;
  /** Motivo de `partial` o `unavailable`; `null` con `complete` o si se abandonó. */
  readonly reason: string | null;
  /** Ticks recuperados entre los dos extremos; `null` con `unavailable` o si se abandonó. */
  readonly recovered_event_count: number | null;
  readonly status: HistoryRecoveryResult['status'] | 'abandoned';
}

/**
 * Resultado saneado de `ingest` (ADR-0015 §7): solo horas del proceso, conteos, códigos, IDs y
 * hashes. Nunca lleva payloads ni precios.
 */
export interface IngestReport {
  /** Las conexiones de la sesión, en orden: su ID (`null` si no llegó a abrirse), su cierre y su fin. */
  readonly connections: readonly DerivSessionConnection[];
  readonly connector_version: string;
  /** Cómo terminó la sesión: `completed`, o `failed` con `reason` y `detail`. */
  readonly end: DerivSessionResult['end'];
  readonly finished_at_utc: string;
  /** Cada recuperación de historia que la sesión pidió, en orden. */
  readonly recoveries: readonly IngestRecovery[];
  /** Release y SHA-256 de `schemas.zip`, o `null` si no cargaron. */
  readonly schemas: DerivSchemaSummary | null;
  readonly source: string;
  readonly started_at_utc: string;
  /** El de `end`. */
  readonly status: 'completed' | 'failed';
  /** La sesión paró porque el evento durable más antiguo del log cumplió 23 horas. */
  readonly stopped_for_retention: boolean;
  readonly symbol: string;
  /** Las esperas antes de cada reintento, en milisegundos y en orden. */
  readonly waits_ms: readonly number[];
}

/** Una recuperación pedida, con lo que `recoverHistory` devolvió, sin horas ni precios. */
function ingestRecovery(outcome: HistoryRecoveryOutcome): IngestRecovery {
  if (outcome.status === 'abandoned') {
    return {
      attempts: null,
      durable: false,
      pages: null,
      reason: null,
      recovered_event_count: null,
      status: 'abandoned',
    };
  }
  const { result } = outcome;
  return {
    attempts: outcome.attempts,
    durable: outcome.durable,
    pages: outcome.pages,
    reason: result.status === 'complete' ? null : result.reason,
    recovered_event_count: result.status === 'unavailable' ? null : result.recovered_event_count,
    status: result.status,
  };
}

/**
 * La captura viva continua (ADR-0015 §7): la sesión de ingesta de Deriv con los almacenes de la
 * captura, el cursor y el latido (`status`), la retención de 23 horas, el esquema de fuente guardado
 * en el almacenamiento de objetos y un sink que no hace nada, porque nada se publica. La primera
 * señal de parada pide `stop` a la sesión, una sola vez; las siguientes no hacen nada, y se escuchan
 * hasta el final, para que una señal repetida no corte la parada. Se resuelve con el resultado
 * saneado cuando la sesión termina. Si el registro operativo no se puede abrir, o la sesión se
 * rechaza con un error de programación, se rechaza con ese error.
 */
export async function runIngest(input: IngestInput): Promise<IngestReport> {
  const startedAt = input.now();
  const { stores } = input;
  const registry = await OperationalRegistry.open({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    source: DERIV_SOURCE,
    store: stores.operational,
  });
  const session = startDerivSession({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    catalog: stores.catalog,
    connect: input.connect,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    fetch: input.fetch,
    lock: input.lock,
    nextId: input.nextId,
    now: input.now,
    openLog: input.openLog,
    random: input.random,
    registry,
    requestedResponses: stores.requestedResponses,
    retentionMs: INGEST_RETENTION_MS,
    scheduler: input.scheduler,
    schemaObjects: stores.objects,
    ...(input.schemaUrl === undefined ? {} : { schemaUrl: input.schemaUrl }),
    serverTime: false,
    // Los ticks ya durables no van a ningún consumidor: la captura no publica nada.
    sink: { invalidFrame: () => undefined, tick: () => undefined },
    status: stores.ingestionStatus,
    symbol: input.symbol,
    // El único escritor del punto de control del estado vivo (ADR-0017 §5).
    writeLiveCheckpoints: true,
  });
  let stopAsked = false;
  const stopListening = input.signals(() => {
    if (!stopAsked) {
      stopAsked = true;
      session.stop();
    }
  });
  let result: DerivSessionResult;
  try {
    result = await session.done;
  } finally {
    stopListening();
  }
  return {
    connections: result.connections,
    connector_version: DERIV_CONNECTOR_VERSION,
    end: result.end,
    finished_at_utc: input.now(),
    recoveries: result.recoveries.map(ingestRecovery),
    schemas: result.schemas,
    source: DERIV_SOURCE,
    started_at_utc: startedAt,
    status: result.end.status,
    stopped_for_retention: result.stopped_for_retention,
    symbol: input.symbol,
    waits_ms: result.waits_ms,
  };
}

/**
 * Código de salida de `ingest`: 0 si la sesión terminó `completed` y 1 si terminó `failed`. Un
 * símbolo que el esquema de la petición `ticks` no admite es un error de uso, 2, como en el smoke,
 * aunque se detecte después de cargar los esquemas.
 */
export function ingestExitCode(report: IngestReport): 0 | 1 | 2 {
  if (report.end.status === 'completed') {
    return 0;
  }
  return report.end.reason === 'request_invalid' ? 2 : 1;
}

/** Lo que necesita `ingestCommand`: los puertos de la captura y cómo abrir sus almacenes. */
export interface IngestDependencies extends Omit<
  IngestInput,
  'lock' | 'openLog' | 'stores' | 'symbol'
> {
  /** El bloqueo de la fuente con esa configuración: `PostgresSessionLockProvider`. */
  readonly lockProvider: (config: WorkerConfig) => SessionLockProvider;
  /** Abre el log con el almacén protegido por el bloqueo: `openLockedSourceLog`. */
  readonly openLog: (lock: SessionLock, input: OpenSourceEventLogInput) => Promise<SourceEventLog>;
  /** Abre los almacenes con esa configuración, ya comprobada: `openStores` y sus migraciones. */
  readonly openStores: (config: WorkerConfig) => IngestStores;
  /** Versión de zlib del writer gzip de segmentos. */
  readonly zlibVersion: string;
}

const failureLine = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ ...fields, status: 'failed' });

/**
 * `ingest` completo, sin efectos propios (ADR-0015 §7): interpreta los argumentos, carga y comprueba
 * la configuración, abre los almacenes, comprueba sin aplicar nada que el esquema tiene todas las
 * migraciones del worker, corre la captura y devuelve la línea JSON y el código de salida. Cierra
 * los almacenes al terminar, de cualquier forma.
 *
 * - Argumentos o configuración inválidos (`UsageError`, `ConfigError`, `IngestConfigError`): salida
 *   2 y una línea con `code` y el mensaje, sin abrir nada.
 * - Faltan migraciones: salida 2, `code: MIGRATIONS_PENDING` y las que faltan, sin tomar el bloqueo.
 * - PostgreSQL no responde al leerlas: salida 1, `code: STORAGE_UNAVAILABLE` y el motivo saneado.
 * - Si no, el resultado de la captura con su código (`ingestExitCode`). Un error inesperado da
 *   `code: UNEXPECTED` y salida 1.
 */
export async function ingestCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: IngestDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let symbol: string;
  let config: WorkerConfig;
  try {
    ({ symbol } = parseIngestArgs(argv));
    config = loadConfig(env);
    checkIngestConfig(config);
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof IngestConfigError
    ) {
      return { exitCode: 2, line: failureLine({ code: error.name, message: error.message }) };
    }
    throw error;
  }
  const { lockProvider, openLog, openStores, zlibVersion, ...ports } = dependencies;
  const stores = openStores(config);
  try {
    let pending: readonly string[];
    try {
      pending = await stores.pendingMigrations();
    } catch (error) {
      return {
        exitCode: 1,
        line: failureLine({
          code: 'STORAGE_UNAVAILABLE',
          message: 'PostgreSQL no respondió al leer las migraciones del esquema.',
          reason: failureReason(error),
        }),
      };
    }
    if (pending.length > 0) {
      return {
        exitCode: 2,
        line: failureLine({
          code: 'MIGRATIONS_PENDING',
          message:
            'Al esquema de BUOH_POSTGRES_SCHEMA le faltan migraciones del worker: aplica las migraciones con db:migrate.',
          pending,
        }),
      };
    }
    const report = await runIngest({
      ...ports,
      lock: lockProvider(config),
      openLog: (lock) =>
        openLog(lock, {
          objects: stores.objects,
          source: DERIV_SOURCE,
          store: stores.sourceLog,
          zlibVersion,
        }),
      stores,
      symbol,
    });
    return { exitCode: ingestExitCode(report), line: JSON.stringify(report) };
  } catch (error) {
    return {
      exitCode: 1,
      line: failureLine({
        code: 'UNEXPECTED',
        message: error instanceof Error ? error.name : 'Error',
      }),
    };
  } finally {
    await stores.close();
  }
}
