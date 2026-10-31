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
import {
  HandedOverLockProvider,
  waitForProductionStart,
  type StartupReads,
  type StartupWaitResult,
} from './ingest-startup.js';
import { type IngestionStatusStore } from './ingestion/status.js';
import {
  OperationalRegistry,
  stderrAlert,
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
import { withLog } from './successive-logs.js';

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
  /**
   * La retención de la captura: por defecto, `INGEST_RETENTION_MS` (ADR-0015 §7). Con `null`,
   * ninguna: ni para a las 23 horas ni comprueba `retention_expired`, porque en `production` la
   * retención la llevan los logs sucesivos (ADR-0018 §4).
   */
  readonly retentionMs?: number | null;
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
 * captura, el cursor y el latido (`status`), la retención de 23 horas salvo con `retentionMs` en
 * `null` (ADR-0018 §4), el esquema de fuente guardado
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
    ...(input.retentionMs === null
      ? {}
      : { retentionMs: input.retentionMs ?? INGEST_RETENTION_MS }),
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
  'lock' | 'openLog' | 'retentionMs' | 'stores' | 'symbol'
> {
  /** El bloqueo de la fuente con esa configuración: `PostgresSessionLockProvider`. */
  readonly lockProvider: (config: WorkerConfig) => SessionLockProvider;
  /** Abre el log con el almacén protegido por el bloqueo: `openLockedSourceLog`. */
  readonly openLog: (lock: SessionLock, input: OpenSourceEventLogInput) => Promise<SourceEventLog>;
  /**
   * En `production`, abre las lecturas de la espera del arranque con esa configuración, ya
   * comprobada (ADR-0018 §4): `openStartupReads`. Fuera de `production` no se llama.
   */
  readonly openStartupReads: (config: WorkerConfig) => StartupReads;
  /**
   * Abre los almacenes con esa configuración, ya comprobada: `openStores` y sus migraciones. En
   * `production`, con el esquema y el prefijo del log activo (`withLog`).
   */
  readonly openStores: (config: WorkerConfig) => IngestStores;
  /** Versión de zlib del writer gzip de segmentos. */
  readonly zlibVersion: string;
}

const failureLine = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({ ...fields, status: 'failed' });

/** El código de la línea de `ingest` cuando una señal la para durante la espera del arranque. */
export const WAIT_STOPPED = 'WAIT_STOPPED';

/**
 * Las señales de parada de todo el comando, escuchadas desde el principio (ADR-0015 §3,
 * «Parada»): quien escucha después, la espera del arranque y la sesión, recibe enseguida una señal
 * que llegó antes, así que una que llega entre la espera y la sesión no se pierde. `close` deja de
 * escucharlas.
 */
function commandSignals(signals: IngestInput['signals']) {
  let raised = false;
  let listener: (() => void) | null = null;
  const stopListening = signals(() => {
    raised = true;
    listener?.();
  });
  return {
    close: stopListening,
    signals: (onSignal: () => void) => {
      listener = onSignal;
      if (raised) {
        onSignal();
      }
      return () => {
        if (listener === onSignal) {
          listener = null;
        }
      };
    },
  };
}

/**
 * `ingest` completo, sin efectos propios (ADR-0015 §7; en `production`, ADR-0018 §4): interpreta
 * los argumentos, carga y comprueba la configuración, prepara la captura, la corre y devuelve la
 * línea JSON y el código de salida. Escucha las señales de parada desde que la configuración es
 * válida (`commandSignals`). Cierra los almacenes al terminar, de cualquier forma.
 *
 * - Argumentos o configuración inválidos (`UsageError`, `ConfigError`, `IngestConfigError`): salida
 *   2 y una línea con `code` y el mensaje, sin abrir nada.
 * - Fuera de `production`, abre los almacenes de la configuración y comprueba, sin aplicar nada, que
 *   el esquema tiene todas las migraciones del worker: si faltan, salida 2, `code:
 *   MIGRATIONS_PENDING` y las que faltan, sin tomar el bloqueo; si PostgreSQL no responde al
 *   leerlas, salida 1, `code: STORAGE_UNAVAILABLE` y el motivo saneado. La captura tiene la
 *   retención de 23 horas.
 * - En `production`, espera el arranque sin escribir nada (`waitForProductionStart`): el log activo,
 *   sus migraciones y el bloqueo. Si una señal la para, salida 0, `status: stopped`, `code:
 *   WAIT_STOPPED` y el motivo por el que esperaba (`waiting`). Si no, abre los almacenes con el
 *   esquema y el prefijo del log activo (`withLog`) y corre la captura sin retención, con el
 *   bloqueo que tomó la espera (`HandedOverLockProvider`).
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
    checkIngestConfig(config, env);
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
  const { lockProvider, openLog, openStartupReads, openStores, signals, zlibVersion, ...ports } =
    dependencies;
  const stop = commandSignals(signals);

  /** La captura sobre los almacenes de `target`, con ese bloqueo y esa retención. */
  const capture = async (
    target: WorkerConfig,
    lock: SessionLockProvider,
    production: boolean,
  ): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> => {
    const stores = openStores(target);
    try {
      if (!production) {
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
      }
      const report = await runIngest({
        ...ports,
        lock,
        openLog: (held) =>
          openLog(held, {
            objects: stores.objects,
            source: DERIV_SOURCE,
            store: stores.sourceLog,
            zlibVersion,
          }),
        // En `production`, la retención la llevan los logs sucesivos (ADR-0018 §4 y §7).
        retentionMs: production ? null : INGEST_RETENTION_MS,
        signals: stop.signals,
        stores,
        symbol,
      });
      return { exitCode: ingestExitCode(report), line: JSON.stringify(report) };
    } finally {
      await stores.close();
    }
  };

  try {
    const provider = lockProvider(config);
    if (config.environment !== 'production') {
      return await capture(config, provider, false);
    }
    const reads = openStartupReads(config);
    let waited: StartupWaitResult;
    try {
      waited = await waitForProductionStart({
        alert: ports.alert ?? stderrAlert,
        lock: provider,
        now: ports.now,
        reads,
        scheduler: ports.scheduler,
        signals: stop.signals,
      });
    } finally {
      await reads.close();
    }
    if (waited.status === 'stopped') {
      return {
        exitCode: 0,
        line: JSON.stringify({ code: WAIT_STOPPED, status: 'stopped', waiting: waited.waiting }),
      };
    }
    const handedOver = new HandedOverLockProvider(waited.lock, provider);
    try {
      return await capture(withLog(config, waited.log), handedOver, true);
    } finally {
      await handedOver.releaseUnused();
    }
  } catch (error) {
    return {
      exitCode: 1,
      line: failureLine({
        code: 'UNEXPECTED',
        message: error instanceof Error ? error.name : 'Error',
      }),
    };
  } finally {
    stop.close();
  }
}
