import type { HistoryRecoveryResult } from '@buoh/contracts';

import { ConfigError, loadConfig, type WorkerConfig } from './config.js';
import type { DerivSchemaSummary } from './deriv/adapter.js';
import type { HistoryRecoveryOutcome } from './deriv/history-recovery.js';
import type { LogQualityProfileRow } from './deriv/log-profile.js';
import type { CatalogStore, RequestedResponseIncidentStore, Scheduler } from './deriv/ports.js';
import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from './deriv/profile.js';
import type { ExpectedSchemaArchive } from './deriv/schema-release.js';
import {
  startDerivSession,
  type DerivSessionConnection,
  type DerivSessionResult,
  type SessionLock,
  type SessionLockProvider,
} from './deriv/session.js';
import type { SocketFactory } from './deriv/socket.js';
import {
  checkIngestConfig,
  IngestConfigError,
  ingestSequences,
  parseIngestArgs,
} from './ingest-args.js';
import {
  locateCaptureLog,
  LockRetention,
  LogCutWatch,
  type CaptureTarget,
  type LogCutSession,
} from './log-cut.js';
import {
  HandedOverLockProvider,
  waitForProductionStart,
  type StartupReads,
  type StartupWaitResult,
} from './ingest-startup.js';
import type { IngestionStatusStore } from './ingestion/status.js';
import {
  OperationalRegistry,
  stderrAlert,
  type OperationalAlert,
  type OperationalStore,
} from './operational/registry.js';
import type { ObjectStore } from './ports.js';
import { UsageError } from './replay-args.js';
import type { SourceLogStore } from './source-log/ports.js';
import {
  failureReason,
  type OpenSourceEventLogInput,
  type SourceEventLog,
} from './source-log/source-event-log.js';
import { R_100_SEQUENCE, withLog, type LogSequence } from './successive-logs.js';

/** La retención de la captura viva: 23 horas, una antes del borrado a las 24 (ADR-0015 §7). */
export const INGEST_RETENTION_MS = 23 * 3_600_000;

/**
 * Con varios símbolos, la espera antes de volver a empezar la captura de uno cuya sesión terminó
 * `failed` (ADR-0021 §1): la primera, el doble cada vez seguida, hasta la máxima. Una captura que
 * duró `INGEST_RESTART_STEADY_MS` o más vuelve a la primera.
 */
export const INGEST_RESTART_FIRST_WAIT_MS = 5_000;
export const INGEST_RESTART_MAX_WAIT_MS = 300_000;
export const INGEST_RESTART_STEADY_MS = 600_000;

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
  /** La fila de `log_quality_profile` del esquema, o `null` (`readLogQualityProfile`, ADR-0020 §4). */
  logProfile(): Promise<LogQualityProfileRow | null>;
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
   * Cómo suelta la sesión su bloqueo: por defecto, su `release`. En `production`, `ingestCommand`
   * lo retiene en un corte para la sesión del log siguiente (ADR-0018 §6, `LockRetention`).
   */
  readonly releaseLock?: (lock: SessionLock) => Promise<void>;
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
  readonly stores: Omit<IngestStores, 'close' | 'logProfile' | 'pendingMigrations'>;
  /** La fila de `log_quality_profile` del log, o `null` o sin ella si no tiene (ADR-0020 §4). */
  readonly logProfile?: LogQualityProfileRow | null;
  readonly symbol: string;
  /**
   * Recibe la sesión en cuanto empieza y devuelve la función que deja de vigilarla, a la que se llama
   * cuando la sesión termina. En `production`, `ingestCommand` vigila así el corte del log (ADR-0018
   * §6, `LogCutWatch`).
   */
  readonly watchSession?: (session: LogCutSession) => () => void;
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
  /**
   * El `profile_id` del perfil de calidad de la sesión, el del log (ADR-0020 §4), o `null` si la
   * preparación falló.
   */
  readonly quality_profile_id: string | null;
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
    ...(input.logProfile === undefined ? {} : { logProfile: input.logProfile }),
    nextId: input.nextId,
    now: input.now,
    openLog: input.openLog,
    random: input.random,
    registry,
    ...(input.releaseLock === undefined ? {} : { releaseLock: input.releaseLock }),
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
  const unwatch = input.watchSession?.(session) ?? null;
  let result: DerivSessionResult;
  try {
    result = await session.done;
  } finally {
    stopListening();
    unwatch?.();
  }
  return {
    connections: result.connections,
    connector_version: DERIV_CONNECTOR_VERSION,
    end: result.end,
    finished_at_utc: input.now(),
    quality_profile_id: result.quality_profile_id,
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
  /**
   * El bloqueo de la fuente con esa configuración, en la secuencia de logs del símbolo (ADR-0021
   * §1; fuera de `production`, la de R_100): `PostgresSessionLockProvider`.
   */
  readonly lockProvider: (config: WorkerConfig, sequence: LogSequence) => SessionLockProvider;
  /** Abre el log con el almacén protegido por el bloqueo: `openLockedSourceLog`. */
  readonly openLog: (lock: SessionLock, input: OpenSourceEventLogInput) => Promise<SourceEventLog>;
  /**
   * En `production`, abre las lecturas de la espera del arranque con esa configuración, ya
   * comprobada (ADR-0018 §4), en la secuencia de logs del símbolo (ADR-0021 §1):
   * `openStartupReads`. Fuera de `production` no se llama.
   */
  readonly openStartupReads: (config: WorkerConfig, sequence: LogSequence) => StartupReads;
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
 * que llegó antes, así que una que llega entre la espera y la sesión no se pierde. Con varios
 * símbolos escuchan a la vez las esperas y las sesiones de todos, y cada señal llega a cada uno
 * (ADR-0021 §1). `raised` dice si ya llegó una. `close` deja de escucharlas.
 */
function commandSignals(signals: IngestInput['signals']) {
  let raised = false;
  const listeners = new Set<{ readonly onSignal: () => void }>();
  const stopListening = signals(() => {
    raised = true;
    for (const listener of [...listeners]) {
      listener.onSignal();
    }
  });
  return {
    close: stopListening,
    raised: () => raised,
    signals: (onSignal: () => void) => {
      const listener = { onSignal };
      listeners.add(listener);
      if (raised) {
        onSignal();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** La espera antes de volver a empezar la captura de un símbolo tras su fallo número `failures`. */
export function ingestRestartDelay(failures: number): number {
  return Math.min(INGEST_RESTART_MAX_WAIT_MS, INGEST_RESTART_FIRST_WAIT_MS * 2 ** (failures - 1));
}

/** El motivo saneado de la línea de una captura: el de su fin o su código, si lo tiene. */
function captureReason(line: string): string | null {
  const parsed = JSON.parse(line) as { code?: unknown; end?: { reason?: unknown } };
  const reason = parsed.end?.reason ?? parsed.code;
  return typeof reason === 'string' ? reason : null;
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
 * - En `production`, espera el arranque sin escribir nada (`waitForProductionStart`): el log en el que
 *   toca capturar (`locateCaptureLog`), sus migraciones y el bloqueo. Si una señal la para, salida 0,
 *   `status: stopped`, `code: WAIT_STOPPED` y el motivo por el que esperaba (`waiting`). Si no, abre
 *   los almacenes con el esquema y el prefijo de ese log (`withLog`) y corre la captura sin
 *   retención, con el bloqueo que tomó la espera (`HandedOverLockProvider`) y la vigilancia de su
 *   corte (`LogCutWatch`, ADR-0018 §6). Tras un corte sigue igual con el log siguiente, con el mismo
 *   bloqueo, y la línea es la de la última sesión. Los logs, el bloqueo y el corte son los de la
 *   secuencia del símbolo (ADR-0021 §1; `ingestSequences`).
 * - En `production`, con varios `--symbol`, captura cada uno así, a la vez y por separado. Una
 *   captura que termina con salida 1 vuelve a empezar dentro del proceso tras su espera
 *   (`restarting`), y las demás siguen; sus alertas llevan `symbol`. La línea lleva `captures`,
 *   con `symbol`, `exit_code` y `result`, la línea de la última captura de cada uno, y `status`; la
 *   salida es la peor de todas. Con uno solo, todo es como antes de las secuencias.
 * - Si no, el resultado de la captura con su código (`ingestExitCode`). Un error inesperado da
 *   `code: UNEXPECTED` y salida 1.
 */
export async function ingestCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  dependencies: IngestDependencies,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let symbols: readonly string[];
  let sequences: readonly LogSequence[] | null;
  let config: WorkerConfig;
  try {
    ({ symbols } = parseIngestArgs(argv));
    config = loadConfig(env);
    checkIngestConfig(config, env);
    sequences = ingestSequences(symbols, config.environment);
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

  /**
   * La captura sobre los almacenes de `target`, con ese bloqueo y esa retención y, en `production`,
   * la vigilancia del corte y cómo se suelta el bloqueo (`cut`).
   */
  const capture = async (
    target: WorkerConfig,
    lock: SessionLockProvider,
    production: { readonly profile: LogQualityProfileRow | null } | null,
    of: { readonly alert?: OperationalAlert; readonly symbol: string },
    cut?: Pick<IngestInput, 'releaseLock' | 'watchSession'>,
  ): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> => {
    const stores = openStores(target);
    try {
      // En `production`, el perfil lo leyó la espera del arranque; fuera, se lee aquí (ADR-0020 §4).
      let logProfile = production?.profile ?? null;
      if (production === null) {
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
        try {
          logProfile = await stores.logProfile();
        } catch (error) {
          return {
            exitCode: 1,
            line: failureLine({
              code: 'STORAGE_UNAVAILABLE',
              message: 'PostgreSQL no respondió al leer el perfil del log.',
              reason: failureReason(error),
            }),
          };
        }
      }
      const report = await runIngest({
        ...ports,
        ...(of.alert === undefined ? {} : { alert: of.alert }),
        lock,
        logProfile,
        openLog: (held) =>
          openLog(held, {
            objects: stores.objects,
            source: DERIV_SOURCE,
            store: stores.sourceLog,
            zlibVersion,
          }),
        // En `production`, la retención la llevan los logs sucesivos (ADR-0018 §4 y §7).
        retentionMs: production === null ? INGEST_RETENTION_MS : null,
        signals: stop.signals,
        stores,
        symbol: of.symbol,
        ...cut,
      });
      return { exitCode: ingestExitCode(report), line: JSON.stringify(report) };
    } finally {
      await stores.close();
    }
  };

  /**
   * La captura en `production` (ADR-0018 §4 y §6): espera el arranque sin escribir nada, captura en
   * el log que toca (`locateCaptureLog`) y vigila su corte (`LogCutWatch`). Tras un corte, vuelve a la
   * espera con el bloqueo que retuvo (`LockRetention`), para el log siguiente, hasta que una sesión
   * termina sin corte o llega la parada. Si al arrancar se salta el log activo porque su hora de
   * corte pasó hace 24 horas o más, deja la alerta `log_cut_forced`. Los logs son los de la
   * secuencia del símbolo (ADR-0021 §1).
   */
  const captureProduction = async (
    provider: SessionLockProvider,
    reads: StartupReads,
    of: {
      readonly alert: OperationalAlert;
      readonly sequence: LogSequence;
      readonly symbol: string;
    },
  ): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> => {
    const { alert, sequence } = of;
    let after: number | null = null;
    let retained: SessionLock | null = null;
    for (;;) {
      const located: { target: CaptureTarget | null } = { target: null };
      const waitLock = retained === null ? null : new HandedOverLockProvider(retained, provider);
      const cutFrom = after;
      let waited: StartupWaitResult;
      try {
        waited = await waitForProductionStart({
          alert,
          lock: waitLock ?? provider,
          now: ports.now,
          reads: {
            locateLog: async () => {
              located.target = await locateCaptureLog(reads, {
                after: cutFrom,
                now: ports.now,
                sequence,
              });
              return located.target?.log ?? null;
            },
            logProfile: (log) => reads.logProfile(log),
            pendingMigrations: (log) => reads.pendingMigrations(log),
          },
          scheduler: ports.scheduler,
          signals: stop.signals,
        });
      } finally {
        // El bloqueo del corte, si la espera no llegó a tomarlo, como tras una parada.
        await waitLock?.releaseUnused();
      }
      if (waited.status === 'stopped') {
        return {
          exitCode: 0,
          line: JSON.stringify({ code: WAIT_STOPPED, status: 'stopped', waiting: waited.waiting }),
        };
      }
      const { log, profile } = waited;
      const skipped = cutFrom === null ? (located.target?.skipped ?? null) : null;
      if (skipped !== null) {
        // El salto al arrancar es un corte forzado sin cierre pedido (ADR-0018 §6, «Al arrancar»):
        // este proceso no abre el log saltado, así que lo que quedó abierto lo dice su informe final.
        alert({
          event: 'log_cut_forced',
          log: String(skipped.number),
          next: String(log.number),
          open_condition_types: null,
          pending_continuity: null,
          reason: 'cut_deadline_passed_at_start',
        });
      }
      const handedOver = new HandedOverLockProvider(waited.lock, provider);
      const retention = new LockRetention();
      const watches: LogCutWatch[] = [];
      let result: { readonly exitCode: 0 | 1 | 2; readonly line: string };
      let next: { readonly after: number; readonly lock: SessionLock | null } | null = null;
      try {
        result = await capture(
          withLog(config, log),
          handedOver,
          { profile },
          { alert, symbol: of.symbol },
          {
            releaseLock: retention.release,
            watchSession: (session) => {
              const watch = new LogCutWatch({
                alert,
                log,
                now: ports.now,
                onCut: () => {
                  retention.retain();
                },
                reads,
                scheduler: ports.scheduler,
                sequence,
                session,
              });
              watches.push(watch);
              watch.start();
              return () => {
                watch.stop();
              };
            },
          },
        );
        const decision = watches[0]?.decision ?? null;
        if (decision !== null && result.exitCode === 0) {
          next = { after: decision.log.number, lock: retention.takeRetained() };
        }
      } finally {
        await handedOver.releaseUnused();
        // Un bloqueo retenido que no pasa a la sesión siguiente se suelta, también si `capture`
        // lanzó: ninguno queda tomado al terminar.
        await retention.takeRetained()?.release();
      }
      if (next === null) {
        return result;
      }
      after = next.after;
      retained = next.lock;
    }
  };

  /** La captura en `production` de un símbolo, con su secuencia, sus lecturas y su bloqueo. */
  const captureSequence = async (
    symbol: string,
    sequence: LogSequence,
    alert: OperationalAlert,
  ): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> => {
    const provider = lockProvider(config, sequence);
    const reads = openStartupReads(config, sequence);
    try {
      return await captureProduction(provider, reads, { alert, sequence, symbol });
    } finally {
      await reads.close();
    }
  };

  /** `true` tras `ms` milisegundos, o `false` en cuanto llega la parada, antes o durante la espera. */
  const waitOrStop = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      // Lo cambian las funciones de abajo: un objeto, para que el compilador no lo dé por fijo.
      const state: { settled: boolean } = { settled: false };
      let unlisten: (() => void) | null = null;
      const finish = (value: boolean) => {
        if (!state.settled) {
          state.settled = true;
          unlisten?.();
          resolve(value);
        }
      };
      const cancel = ports.scheduler.schedule(ms, () => {
        finish(true);
      });
      unlisten = stop.signals(() => {
        cancel();
        finish(false);
      });
      // Con la parada ya llegada, `signals` llamó a la función antes de devolver `unlisten`.
      if (state.settled) {
        unlisten();
      }
    });

  /**
   * Con varios símbolos (ADR-0021 §1), la captura de uno: si su sesión termina `failed`, o con un
   * error inesperado, deja la alerta `ingest_capture_restart`, espera (`ingestRestartDelay`) y
   * vuelve a empezar, desde la espera del arranque, mientras las demás siguen. Termina con la
   * parada, con la línea de su última captura, o con una salida 2, que volver a empezar no cambia.
   */
  const restarting = async (
    symbol: string,
    sequence: LogSequence,
  ): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string; readonly symbol: string }> => {
    const base = ports.alert ?? stderrAlert;
    const alert: OperationalAlert = (payload) => {
      base({ ...payload, symbol });
    };
    let failures = 0;
    for (;;) {
      const startedMs = Date.parse(ports.now());
      let result: { readonly exitCode: 0 | 1 | 2; readonly line: string };
      try {
        result = await captureSequence(symbol, sequence, alert);
      } catch (error) {
        result = {
          exitCode: 1,
          line: failureLine({
            code: 'UNEXPECTED',
            message: error instanceof Error ? error.name : 'Error',
          }),
        };
      }
      if (result.exitCode !== 1 || stop.raised()) {
        return { ...result, symbol };
      }
      failures = Date.parse(ports.now()) - startedMs >= INGEST_RESTART_STEADY_MS ? 1 : failures + 1;
      const delay = ingestRestartDelay(failures);
      alert({
        event: 'ingest_capture_restart',
        reason: captureReason(result.line),
        wait_ms: String(delay),
      });
      if (!(await waitOrStop(delay))) {
        return { ...result, symbol };
      }
    }
  };

  try {
    const [first] = symbols;
    if (first === undefined) {
      throw new TypeError('ingest sin símbolos.');
    }
    if (sequences === null) {
      return await capture(config, lockProvider(config, R_100_SEQUENCE), null, { symbol: first });
    }
    const [only] = sequences;
    if (sequences.length === 1 && only !== undefined) {
      // Con un solo símbolo, una sesión que falla termina el proceso, como antes de las secuencias, y
      // Render lo reinicia: no hay otra captura que deba seguir.
      return await captureSequence(first, only, ports.alert ?? stderrAlert);
    }
    const results = await Promise.all(
      sequences.map((sequence, index) => restarting(symbols[index] ?? first, sequence)),
    );
    const worst = (code: 0 | 1 | 2) => results.some((result) => result.exitCode === code);
    const exitCode = worst(2) ? 2 : worst(1) ? 1 : 0;
    return {
      exitCode,
      line: JSON.stringify({
        captures: results.map((result) => ({
          exit_code: result.exitCode,
          result: JSON.parse(result.line) as unknown,
          symbol: result.symbol,
        })),
        status: exitCode === 0 ? 'completed' : 'failed',
      }),
    };
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
