import { type IngestionCursor, type SourceEvent } from '@buoh/contracts';
import { deriveMarketData, sourceEventTime, type DerivedMarketData } from '@buoh/domain';

import { RawFirstIngestor } from '../ingestion/raw-first-ingestor.js';
import {
  INGESTION_CURSOR_SCHEMA_VERSION,
  type IngestionHeartbeat,
  type IngestionStatusStore,
} from '../ingestion/status.js';
import { stderrAlert, type OperationalAlert } from '../operational/registry.js';
import {
  failureReason,
  LogIntegrityError,
  LogReadError,
  type SourceEventLog,
} from '../source-log/source-event-log.js';
import {
  assertDuration,
  prepareDerivAdapter,
  startDerivAttempt,
  type DerivAdapterInput,
  type DerivAttempt,
  type DerivPreparation,
  type DerivSchemaSummary,
} from './adapter.js';
import {
  type DerivConnection,
  type DerivConnectionResult,
  type DerivSessionEnd,
} from './connection.js';
import { GapWatch, type GapWatchFailure } from './gap-watch.js';
import { type HistoryRecoveryOutcome } from './history-recovery.js';

/** El bloqueo de la fuente que tiene la sesión (ADR-0012 §9): `SourceLock` en PostgreSQL. */
export interface SessionLock {
  /**
   * El PID de PostgreSQL de la sesión que lo tiene (`pg_backend_pid()`). La sesión de ingesta lo
   * escribe en cada latido (ADR-0015 §6), para que `data:health` (ADR-0015 §8, PR 6) reconozca al
   * escritor vivo de este esquema. Sin él, la sesión no escribe latidos: el bloqueo en memoria del
   * smoke no lo tiene.
   */
  readonly backendPid?: number;
  /** `false` desde que se perdió: las escrituras del log protegido por él fallan. */
  readonly held: boolean;
  /** Lo suelta. Nunca falla. */
  release(): Promise<void>;
}

/**
 * PostgreSQL no respondió al tomar el bloqueo de la fuente: no dice nada de quién lo tiene, así que
 * la sesión espera y lo intenta otra vez (ADR-0015 §3, «Bloqueo»). Se crea con la causa, el error
 * de la conexión o de la consulta, y la guarda como `cause`. `reason` sale de ella saneado
 * (`failureReason`: su código o su nombre, nunca su mensaje, que puede llevar el rol, la base de
 * datos o el host), y el mensaje solo lleva ese motivo.
 */
export class SourceLockUnavailableError extends Error {
  readonly reason: string;

  constructor(cause: unknown) {
    const reason = failureReason(cause);
    super(`Bloqueo de la fuente no disponible: ${reason}`, { cause });
    this.name = 'SourceLockUnavailableError';
    this.reason = reason;
  }
}

/**
 * Toma el bloqueo de la fuente. En PostgreSQL envuelve `SourceLock.acquire`: un fallo de la conexión
 * o de la consulta lo convierte en `new SourceLockUnavailableError(causa)`, que sanea el motivo.
 */
export interface SessionLockProvider {
  /**
   * Devuelve el bloqueo tomado (`held` es `true` al devolverlo), o `null` si lo tiene otro proceso.
   * Si PostgreSQL no responde, lanza `SourceLockUnavailableError`, y la sesión espera y lo intenta
   * otra vez. Cualquier otro rechazo es un error de programación: la sesión suelta su bloqueo y se
   * rechaza con él.
   */
  acquire(): Promise<SessionLock | null>;
}

/** Motivo de la alerta de un bloqueo que ya no está tomado al recibirlo, como `SOURCE_LOCK_LOST`. */
const LOCK_LOST = 'source_lock_lost';

/**
 * Los puertos del adaptador, salvo el log ya abierto, `reopenLog` y la duración de cada conexión: la
 * sesión abre el log con su bloqueo. Más el bloqueo, la apertura del log y el azar de la espera.
 */
export interface DerivSessionInput extends Pick<
  DerivAdapterInput,
  | 'alert'
  | 'catalog'
  | 'connect'
  | 'expected'
  | 'fetch'
  | 'nextId'
  | 'now'
  | 'registry'
  | 'requestedResponses'
  | 'scheduler'
  | 'schemaUrl'
  | 'serverTime'
  | 'sink'
  | 'symbol'
> {
  readonly lock: SessionLockProvider;
  /**
   * Abre el log con el almacén protegido por ese bloqueo (`lockedSourceLogStore` en PostgreSQL). Si
   * un almacén no responde, lanza `LogReadError`; si el contenido no pasa sus comprobaciones,
   * `LogIntegrityError` (`SourceEventLog.open`).
   */
  readonly openLog: (lock: SessionLock) => Promise<SourceEventLog>;
  /** Azar de la espera entre intentos, en [0, 1). */
  readonly random: () => number;
  /**
   * Duración prevista de toda la sesión, en milisegundos (ADR-0015 §4 y §9): un entero positivo, o
   * `startDerivSession` lanza `TypeError`. Cuenta desde el primer tick durable de la sesión, como el
   * corte (`interruptAfterMs`), y al cumplirse la sesión pide el cierre previsto (`finish`) a la
   * conexión en curso; sin ningún tick durable, no empieza a contar. Si queda una recuperación de
   * historia pendiente, lo pide después de su resultado, como mucho 300 000 ms después del plazo;
   * pasado ese tope, para. Después de `finish` no reconecta ni pide más historia. Es de la sesión,
   * nunca de una conexión: la sesión no la pasa a sus conexiones. Sin ella, la sesión sigue hasta la
   * parada o un fallo.
   */
  readonly durationMs?: number;
  /**
   * El corte del smoke de reconexión (ADR-0015 §9), en milisegundos: un entero positivo, o
   * `startDerivSession` lanza `TypeError`. Cuenta desde el primer tick durable de la sesión, y al
   * cumplirse corta una sola vez la conexión en curso con `interrupt('smoke_interrupt')`, como una
   * pérdida (`transport_error`): la sesión reconecta y recupera el hueco como tras cualquier cierre
   * no pedido. No corta nada si entonces no hay conexión en curso, porque espera para reconectar, o
   * si ya se cumplió el plazo del cierre previsto (`durationMs`), que cuenta desde el mismo tick: eso
   * solo pasa con un corte que no es menor que la duración. Sin él, la sesión nunca corta su
   * conexión.
   */
  readonly interruptAfterMs?: number;
  /**
   * El cursor y el latido de la ingesta (ADR-0015 §6): `PostgresIngestionStatusStore` en
   * PostgreSQL. Al arrancar, después de leer el log, la sesión lee de él el último cursor del símbolo
   * y los símbolos con algún cursor de la fuente, y comprueba el log con ellos (ADR-0015 §5). Si no
   * responde, avisa con `ingestion_status_unavailable` y el motivo saneado, espera y lo intenta otra
   * vez, como con el log. Después escribe en él el cursor del símbolo, tras cada `ConnectionClosed`
   * durable y al terminar, y, si el bloqueo expone su `backendPid`, el latido. Una escritura que
   * falla deja la misma alerta, y la ingesta sigue. Sin él, como en el smoke, la sesión no lee ni
   * escribe cursor ni latido.
   */
  readonly status?: IngestionStatusStore;
  /**
   * La retención del log, en milisegundos (ADR-0015 §7): un entero positivo, o `startDerivSession`
   * lanza `TypeError`; `ingest` pasa 23 horas. Si el evento durable más antiguo del log ya la
   * cumplió, la sesión no arranca (`retention_expired`); si no, para como con `stop` cuando la
   * cumple, contada desde el primer evento durable de la sesión si el log estaba vacío. Sin ella, la
   * sesión no mira la antigüedad del log.
   */
  readonly retentionMs?: number;
}

/** Motivo del corte del smoke de reconexión (ADR-0015 §9). */
export const SMOKE_INTERRUPT_REASON = 'smoke_interrupt';

/** Cada cuánto escribe la sesión su latido mientras tiene el bloqueo (ADR-0015 §6). */
export const INGESTION_HEARTBEAT_INTERVAL_MS = 15_000;

/** Una conexión de la sesión: su ID (`null` si no llegó a abrirse), su cierre y cómo terminó. */
export interface DerivSessionConnection {
  readonly closure: DerivConnectionResult['closure'];
  readonly connection_id: string | null;
  readonly end: DerivSessionEnd;
}

export interface DerivSessionResult {
  /**
   * Catálogo vigente del último intento, o `null` si ese intento no llegó a abrirse o no lo
   * obtuvo.
   */
  readonly catalog: DerivConnectionResult['catalog'];
  /** Las conexiones, en orden. */
  readonly connections: readonly DerivSessionConnection[];
  /**
   * `completed` tras la parada o el cierre previsto; `failed` si no se puede seguir sin
   * intervención, con un motivo estable (`reason`) y un dato saneado (`detail`).
   */
  readonly end:
    | { readonly status: 'completed' }
    | { readonly detail: string | null; readonly reason: string; readonly status: 'failed' };
  /**
   * Cómo terminó cada recuperación de historia que la sesión pidió, en orden: como mucho una por
   * conexión (`recoverHistory`, ADR-0015 §4).
   */
  readonly recoveries: readonly HistoryRecoveryOutcome[];
  /** Release y SHA-256 de los esquemas cargados, o `null` si la carga falló. */
  readonly schemas: DerivSchemaSummary | null;
  /**
   * Desfase con el servidor medido en el último intento, o `null` si ese intento no llegó a abrirse
   * o no lo midió.
   */
  readonly server_time_offset_ms: number | null;
  /**
   * La sesión paró porque el evento durable más antiguo del log cumplió `retentionMs` (ADR-0015 §7):
   * como con `stop`, su fin es `completed`, salvo que antes falle algo que no se puede reintentar.
   */
  readonly stopped_for_retention: boolean;
  /**
   * `subscription.id` del último intento, o `null` si ese intento no llegó a abrirse o no recibió
   * el primer tick de su suscripción.
   */
  readonly subscription_id: string | null;
  /**
   * Las esperas antes de cada reintento, en milisegundos y en orden, también la que corta una
   * parada.
   */
  readonly waits_ms: readonly number[];
}

export interface DerivSession {
  /**
   * Se resuelve cuando la sesión termina; se rechaza solo con un error de programación, después de
   * soltar el bloqueo.
   */
  readonly done: Promise<DerivSessionResult>;
  /** La parada por señal (ADR-0015 §3, «Parada»). No hace nada si ya se pidió. */
  stop(): void;
}

type SessionEnd = DerivSessionResult['end'];

const COMPLETED: SessionEnd = { status: 'completed' };

/** Tope de d, en milisegundos (ADR-0015 §3, «Espera»). */
const MAX_BACKOFF_MS = 60_000;
/**
 * Tiempo seguido de conexión con ticks durables, desde el primero hasta el fin, que devuelve el
 * contador de intentos a 1 (ADR-0015 §3, «Espera»).
 */
const STEADY_CONNECTION_MS = 60_000;
/**
 * Lo que el cierre previsto espera, después del plazo, a una recuperación de historia pendiente;
 * pasado, la sesión para y la abandona.
 */
const PLANNED_CLOSE_BOUND_MS = 300_000;
/**
 * Lo más que la parada por retención espera de una vez antes de volver a mirar el reloj, como la
 * espera para pasar el cierre anterior: un ajuste del reloj, o un temporizador que se retrasa con el
 * equipo suspendido, se nota en un minuto como mucho, y una retención enorme nunca llega entera al
 * temporizador.
 */
const RETENTION_STEP_MS = 60_000;

/**
 * La espera del intento n, desde 1 (ADR-0015 §3, «Espera»): con d = mín(60 000, 1000 · 2^(n−1)) ms,
 * d/2 + `random` · d/2, en milisegundos enteros. d/2 es entero, así que redondear hacia abajo la
 * parte aleatoria deja la espera entre d/2 y d − 1.
 */
function backoffDelay(attempt: number, random: number): number {
  if (!(random >= 0 && random < 1)) {
    throw new TypeError(`random() tiene que dar un número en [0, 1), no ${String(random)}.`);
  }
  const half = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempt - 1)) / 2;
  return half + Math.floor(random * half);
}

const failed = (reason: string, detail: string | null = null): SessionEnd => ({
  detail,
  reason,
  status: 'failed',
});

/** El log no se puede derivar (ADR-0015 §2 y §5): hace falta un log nuevo. */
const notDerivable = (error: unknown): SessionEnd =>
  failed('log_not_derivable', failureReason(error));

/**
 * Un intento o una conexión que se rechazan: con `LogIntegrityError`, el log no pasa sus
 * comprobaciones (`log_not_derivable`); cualquier otro error es de programación y se relanza.
 */
function integrityEnd(error: unknown): SessionEnd {
  if (error instanceof LogIntegrityError) {
    return notDerivable(error);
  }
  throw error;
}

const isNotDerivable = (end: SessionEnd): boolean =>
  end.status === 'failed' && end.reason === 'log_not_derivable';

/** El ID de un source event en el índice: el `observation_id` de un frame y el `event_id` de los demás. */
const sourceEventId = (event: SourceEvent): string =>
  event.kind === 'raw_source_frame' ? event.observation_id : event.event_id;

/** Lo que el arranque lee del almacén del cursor (ADR-0015 §5). */
interface StoredCursors {
  /** El último cursor del símbolo pedido, o `null` si no tiene ninguno. */
  readonly latest: IngestionCursor | null;
  /** Los símbolos que tienen algún cursor de la fuente. */
  readonly symbols: readonly string[];
}

/** El último cursor del símbolo y los símbolos con algún cursor de la fuente. */
async function readCursors(
  status: IngestionStatusStore,
  preparation: DerivPreparation,
): Promise<StoredCursors> {
  const { source } = preparation.profile;
  const symbols = await status.cursorSymbols(source);
  const latest = await status.latestCursor(source, preparation.symbol);
  return { latest: latest?.cursor ?? null, symbols };
}

/** Lo que la sesión toma del log al arrancar, cuando pasa sus comprobaciones. */
interface StartupLog {
  /** La conexión del último evento del log, o `null` si está vacío. */
  readonly connection_id: string | null;
  /** La hora del último tick del símbolo en la derivación, la mayor, o `null` si no tiene ninguno. */
  readonly high_watermark_utc: string | null;
  /** La hora del evento durable más antiguo, el primero del log, o `null` si está vacío. */
  readonly oldest_utc: string | null;
}

/**
 * La hora del último tick derivado del símbolo: los ticks van en orden canónico, por su hora, así
 * que es la mayor, el high-watermark del símbolo. `null` si no tiene ninguno.
 */
function latestTickTime(ticks: DerivedMarketData['ticks'], symbol: string): string | null {
  return ticks.findLast((tick) => tick.symbol === symbol)?.event_time_utc ?? null;
}

/**
 * Las comprobaciones del log antes de conectar (ADR-0015 §5), en este orden:
 *
 * 1. todos sus frames son de este conector (`connector_version_mismatch`);
 * 2. se deriva con el perfil de medición (`log_not_derivable`);
 * 3. es del símbolo pedido (`symbol_mismatch`): ningún cursor de la fuente es de otro símbolo y
 *    ningún tick tampoco. Un log lo escribe una sesión de un solo símbolo, así que sus cursores dan
 *    su símbolo, también si no tiene ticks;
 * 4. el último cursor del símbolo apunta a un evento del log (`cursor_ahead_of_log`): si no, el log
 *    perdió datos confirmados;
 * 5. con `retentionMs`, el evento durable más antiguo, el primero del log, no la cumplió todavía
 *    (`retention_expired`, ADR-0015 §7). Su hora es la de `sourceEventTime`: la recepción de un
 *    frame y `occurred_at_utc` de los demás.
 *
 * Sin `cursors`, no hay comprobación con el cursor. Devuelve el fin `failed` o, si las pasa, lo que
 * la sesión toma del log.
 */
function checkLog(
  segments: readonly (readonly SourceEvent[])[],
  preparation: DerivPreparation,
  startup: {
    readonly cursors: StoredCursors | null;
    readonly now: string;
    readonly retentionMs: number | undefined;
  },
): { readonly end: SessionEnd } | { readonly log: StartupLog } {
  const { profile, symbol } = preparation;
  const foreign = segments.some((segment) =>
    segment.some(
      (event) =>
        event.kind === 'raw_source_frame' && event.connector_version !== profile.connector_version,
    ),
  );
  if (foreign) {
    return { end: failed('connector_version_mismatch') };
  }
  let derived: DerivedMarketData;
  try {
    derived = deriveMarketData(segments, profile);
  } catch (error) {
    return { end: notDerivable(error) };
  }
  // El perfil admite solo el símbolo pedido, así que todo tick derivado es de ese símbolo: un tick de
  // otro símbolo queda como frame inválido con `symbol_not_allowed`.
  const otherTicks = derived.incidents.some(
    (incident) =>
      incident.incident_type === 'invalid_source_frame' &&
      incident.evidence.reason === 'symbol_not_allowed',
  );
  const { cursors } = startup;
  const otherCursor = cursors?.symbols.some((item) => item !== symbol) === true;
  if (otherCursor || otherTicks) {
    return { end: failed('symbol_mismatch') };
  }
  const events = segments.flat();
  const latest = cursors?.latest ?? null;
  if (
    latest !== null &&
    !events.some((event) => sourceEventId(event) === latest.last_durable_source_event_id)
  ) {
    return { end: failed('cursor_ahead_of_log') };
  }
  const oldest = events[0];
  const oldestUtc = oldest === undefined ? null : sourceEventTime(oldest);
  if (
    startup.retentionMs !== undefined &&
    oldestUtc !== null &&
    Date.parse(startup.now) >= Date.parse(oldestUtc) + startup.retentionMs
  ) {
    return { end: failed('retention_expired') };
  }
  return {
    log: {
      connection_id: events.at(-1)?.connection_id ?? null,
      high_watermark_utc: latestTickTime(derived.ticks, symbol),
      oldest_utc: oldestUtc,
    },
  };
}

/** Una sesión en curso: su estado vive aquí, y `startDerivSession` expone `done` y `stop`. */
class SessionRun {
  readonly done: Promise<DerivSessionResult>;
  readonly #input: DerivSessionInput;
  readonly #connections: DerivSessionConnection[] = [];
  readonly #waits: number[] = [];
  #stopped = false;
  #lock: SessionLock | null = null;
  #ingestor: RawFirstIngestor | null = null;
  #connection: DerivConnection | null = null;
  #summary: DerivSchemaSummary | null = null;
  #last: DerivConnectionResult | null = null;
  /** Corta la espera en curso, entre intentos o para volver a tomar el bloqueo. */
  #cancelWait: (() => void) | null = null;
  /** Aborta el intento en curso antes de su conexión: la reparación o la espera para pasarla. */
  #abort: AbortController | null = null;
  /** n, el intento desde el último reinicio del contador: da la próxima espera. */
  #attempt = 1;
  /** Cuándo quedó durable el primer tick de la conexión en curso, en ms desde la época. */
  #firstTickAt: number | null = null;
  /** La vigilancia del hueco pendiente durante la conexión en curso (ADR-0015 §4). */
  #watch: GapWatch | null = null;
  /** Los resultados de las recuperaciones pedidas, en orden. */
  readonly #recoveries: Promise<HistoryRecoveryOutcome>[] = [];
  /** La vigilancia del hueco no pudo seguir: la sesión termina cuando la conexión termine. */
  #failure: GapWatchFailure | null = null;
  /** Ya empezó a contar el plazo del cierre previsto, con el primer tick durable de la sesión. */
  #deadlineArmed = false;
  #cancelDeadline: (() => void) | null = null;
  /** El plazo ya se cumplió: se pide el cierre previsto en cuanto no quede recuperación pendiente. */
  #due = false;
  /**
   * Una conexión aceptó el cierre previsto (`finish` devolvió `true`): desde entonces la sesión no
   * reconecta ni empieza ninguna recuperación de historia.
   */
  #finishAsked = false;
  /** Cancela el tope de la espera a la recuperación pendiente después del plazo. */
  #cancelBound: (() => void) | null = null;
  /** Ya empezó a contar el corte del smoke, con el primer tick durable de la sesión. */
  #interruptArmed = false;
  #cancelInterrupt: (() => void) | null = null;
  /** Ya empezó a contar la retención, desde el evento durable más antiguo del log. */
  #retentionArmed = false;
  #cancelRetention: (() => void) | null = null;
  /** La retención paró la sesión. */
  #stoppedForRetention = false;
  /** La preparación, para el cursor y el latido: se conoce después de cargar los esquemas. */
  #preparation: DerivPreparation | null = null;
  /** La ejecución que va en cada latido: un UUIDv7 del arranque, solo con `status`. */
  readonly #runId: string | null;
  /** El estado de la conexión que va en el latido. */
  #connectionState: IngestionHeartbeat['connection_state'] = 'connecting';
  #heartbeatsStarted = false;
  #cancelHeartbeat: (() => void) | null = null;
  /** Las escrituras del cursor y del latido, en orden. Nunca se rechaza: un fallo solo avisa. */
  #statusWrites: Promise<void> = Promise.resolve();
  /** La conexión del último evento durable del log: la del cursor. */
  #lastConnectionId: string | null = null;
  /** El high-watermark del símbolo: la hora del último tick durable, la mayor, o `null`. */
  #highWatermark: string | null = null;

  constructor(input: DerivSessionInput) {
    this.#input = input;
    // Lo primero que pide al generador: así la ejecución es el primer ID de la sesión.
    this.#runId = input.status === undefined ? null : input.nextId();
    this.done = this.#run();
  }

  /**
   * La parada (ADR-0015 §3, «Parada»): con una conexión en curso, la para, y la sesión termina cuando
   * esa conexión termina, sin reconectar; si espera, corta la espera, y si un intento todavía no
   * conectó, lo aborta sin socket. Una recuperación de historia que espera sus 2000 ms ya no se pide;
   * una en curso la abandona la conexión.
   */
  stop(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#cancelTimers();
    this.#watch?.cancel();
    this.#cancelWait?.();
    this.#abort?.abort();
    this.#connection?.stop();
  }

  async #run(): Promise<DerivSessionResult> {
    let end: SessionEnd;
    try {
      end = await this.#session();
    } catch (error) {
      this.#cancelTimers();
      await this.#settleStatus();
      await this.#releaseLock();
      throw error;
    }
    this.#cancelTimers();
    try {
      // Con el log sano y el bloqueo vigente, cierra el segmento abierto (ADR-0015 §3, «Parada»).
      // Un log que no pasa sus comprobaciones no se toca, uno fallido no lo cierra `rotate`, y uno
      // desactualizado tras volver a tomar el bloqueo lo reabre antes con el bloqueo nuevo: si
      // entonces su contenido no pasa las comprobaciones, el fin es `log_not_derivable` y el
      // segmento queda abierto.
      if (this.#ingestor !== null && this.#lock?.held === true && !isNotDerivable(end)) {
        try {
          await this.#ingestor.rotate('requested');
        } catch (error) {
          end = integrityEnd(error);
        }
        // El cursor al parar, después de cerrar el segmento (ADR-0015 §6), mientras el bloqueo
        // sigue tomado: otro proceso todavía no puede haber escrito el log.
        if (!isNotDerivable(end)) {
          this.#persistCursor();
        }
      }
    } finally {
      // Antes de soltar el bloqueo: después de `done` no se escribe nada más.
      await this.#settleStatus();
      await this.#releaseLock();
    }
    const last = this.#last;
    // Cada una se resolvió antes de que terminara su conexión.
    const recoveries = await Promise.all(this.#recoveries);
    return {
      catalog: last?.catalog ?? null,
      connections: [...this.#connections],
      end,
      recoveries,
      schemas: this.#summary,
      server_time_offset_ms: last?.server_time_offset_ms ?? null,
      stopped_for_retention: this.#stoppedForRetention,
      subscription_id: last?.subscription_id ?? null,
      waits_ms: [...this.#waits],
    };
  }

  async #session(): Promise<SessionEnd> {
    const input = this.#input;
    const preparation = await prepareDerivAdapter({ ...input, related_refs: [] });
    this.#summary = preparation.summary;
    if (preparation.status === 'failed') {
      return preparation.end;
    }
    this.#preparation = preparation;
    const opened = await this.#openLog(preparation);
    if ('end' in opened) {
      return opened.end;
    }
    const { log, startup } = opened;
    // El cursor parte de lo que el arranque derivó del log (ADR-0015 §5 y §6).
    this.#lastConnectionId = startup.connection_id;
    this.#raiseWatermark(startup.high_watermark_utc);
    const ingestor = new RawFirstIngestor({
      log,
      nextId: input.nextId,
      now: input.now,
      onDurable: (event) => {
        this.#onDurable(event);
      },
      profile: preparation.profile,
      registry: input.registry,
      // Siempre con el bloqueo vigente: después de perderlo, la sesión toma otro antes de escribir.
      reopenLog: () => input.openLog(this.#heldLock()),
      sink: {
        invalidFrame: (item) => {
          input.sink.invalidFrame(item);
        },
        nonTickFrame: (item) => {
          input.sink.nonTickFrame?.(item);
        },
        tick: (tick) => {
          this.#firstTickAt ??= Date.parse(input.now());
          this.#armDeadline();
          this.#armInterrupt();
          if (tick.symbol === preparation.symbol) {
            this.#raiseWatermark(tick.event_time_utc);
          }
          input.sink.tick(tick);
          // Ya durable: si es posterior al high-watermark del hueco, la sesión vuelve a derivar.
          this.#watch?.onTick(tick);
        },
      },
    });
    this.#ingestor = ingestor;
    if (startup.oldest_utc !== null) {
      this.#armRetention(startup.oldest_utc);
    }
    for (;;) {
      if (this.#stopped) {
        return COMPLETED;
      }
      if (this.#lock?.held !== true) {
        // Antes de reconectar, un bloqueo nuevo (ADR-0015 §3, «Bloqueo»).
        const retaken = await this.#takeLock();
        if (retaken !== null) {
          return retaken;
        }
        // El log abierto escribe con el bloqueo anterior, y otro proceso pudo escribir mientras
        // tanto: la reparación del intento lo reabre y relee la conexión anterior.
        ingestor.markLogStale();
        continue;
      }
      const end = await this.#connect(ingestor, preparation);
      if (end !== null) {
        return end;
      }
      if (!(await this.#backoff())) {
        return COMPLETED;
      }
    }
  }

  /**
   * Toma el bloqueo, abre el log con él, lo lee entero, lee el cursor si tiene `status` y comprueba
   * el log antes de conectar (`checkLog`, ADR-0015 §5). Si un almacén del log o el del cursor no
   * responde, espera y lo intenta otra vez, con un bloqueo nuevo si mientras tanto se perdió. Si el
   * contenido del log no pasa sus comprobaciones, el fin es `log_not_derivable`.
   */
  async #openLog(
    preparation: DerivPreparation,
  ): Promise<
    { readonly end: SessionEnd } | { readonly log: SourceEventLog; readonly startup: StartupLog }
  > {
    for (;;) {
      // También una parada durante la carga de los esquemas, que no se corta: termina al acabar.
      if (this.#stopped) {
        return { end: COMPLETED };
      }
      if (this.#lock?.held !== true) {
        const taken = await this.#takeLock();
        if (taken !== null) {
          return { end: taken };
        }
        // El latido de arranque, con el primer bloqueo (ADR-0015 §6).
        this.#startHeartbeats();
        continue;
      }
      let log: SourceEventLog;
      let segments: SourceEvent[][];
      try {
        log = await this.#input.openLog(this.#heldLock());
        segments = await log.readDurableSegments();
      } catch (error) {
        if (error instanceof LogIntegrityError) {
          return { end: notDerivable(error) };
        }
        if (!(error instanceof LogReadError)) {
          throw error;
        }
        this.#alert({ event: 'source_log_unavailable', reason: error.reason });
        if (!(await this.#backoff())) {
          return { end: COMPLETED };
        }
        continue;
      }
      const { status } = this.#input;
      let cursors: StoredCursors | null = null;
      if (status !== undefined) {
        try {
          cursors = await readCursors(status, preparation);
        } catch (error) {
          // Cualquier rechazo cuenta como un almacén que no responde: el almacén no distingue otro.
          // El motivo sale saneado: el mensaje de PostgreSQL puede llevar el host o el rol.
          this.#alert({ event: 'ingestion_status_unavailable', reason: failureReason(error) });
          if (!(await this.#backoff())) {
            return { end: COMPLETED };
          }
          continue;
        }
      }
      const checked = checkLog(segments, preparation, {
        cursors,
        now: this.#input.now(),
        retentionMs: this.#input.retentionMs,
      });
      return 'end' in checked ? checked : { log, startup: checked.log };
    }
  }

  /**
   * Toma un bloqueo nuevo, después de soltar el anterior si lo había: devuelve `null` cuando lo
   * tiene, o el fin `failed` con `source_lock_taken` si lo tiene otro proceso. Si PostgreSQL no
   * responde (`SourceLockUnavailableError`), o si el bloqueo que recibe ya no está tomado, y entonces
   * lo suelta, avisa con `source_lock_unavailable` y su motivo, espera y lo intenta otra vez
   * (ADR-0015 §3, «Bloqueo»). Cualquier otro rechazo de `acquire` es de programación y se relanza.
   * Tras la parada, el fin es `completed` y no toma otro. Quien la llama vuelve a mirar la parada
   * antes de seguir: un bloqueo tomado mientras llegaba la parada lo suelta el cierre de la sesión.
   */
  async #takeLock(): Promise<SessionEnd | null> {
    await this.#releaseLock();
    for (;;) {
      // Una parada mientras se soltaba el bloqueo anterior: no se toma otro.
      if (this.#stopped) {
        return COMPLETED;
      }
      let lock: SessionLock | null;
      try {
        lock = await this.#input.lock.acquire();
      } catch (error) {
        if (!(error instanceof SourceLockUnavailableError)) {
          throw error;
        }
        this.#alert({ event: 'source_lock_unavailable', reason: error.reason });
        if (!(await this.#backoff())) {
          return COMPLETED;
        }
        continue;
      }
      if (lock === null) {
        return failed('source_lock_taken');
      }
      if (!lock.held) {
        // Perdido antes de usarlo: tomar otro enseguida volvería a tomar y soltar sin esperar.
        await lock.release();
        this.#alert({ event: 'source_lock_unavailable', reason: LOCK_LOST });
        if (!(await this.#backoff())) {
          return COMPLETED;
        }
        continue;
      }
      this.#lock = lock;
      return null;
    }
  }

  /** Alerta saneada, en stderr por defecto. */
  #alert(payload: Parameters<OperationalAlert>[0]): void {
    (this.#input.alert ?? stderrAlert)(payload);
  }

  /** El bloqueo vigente; la sesión solo abre el log después de tomarlo. */
  #heldLock(): SessionLock {
    if (this.#lock === null) {
      throw new TypeError('La sesión abre el log sin bloqueo.');
    }
    return this.#lock;
  }

  /**
   * Un intento y su conexión, entre el latido `connecting`, al empezarlo, y el `disconnected`, al
   * terminar, de cualquier forma (ADR-0015 §6). Devuelve el fin de la sesión según cómo terminó la
   * conexión (ADR-0015 §3), o `null` para esperar y reconectar: no conectó, o la conexión terminó
   * `disconnected` o `paused`.
   */
  async #connect(
    ingestor: RawFirstIngestor,
    preparation: DerivPreparation,
  ): Promise<SessionEnd | null> {
    this.#setConnectionState('connecting');
    try {
      return await this.#runAttempt(ingestor, preparation);
    } finally {
      this.#setConnectionState('disconnected');
    }
  }

  /** El intento de `#connect`. */
  async #runAttempt(
    ingestor: RawFirstIngestor,
    preparation: DerivPreparation,
  ): Promise<SessionEnd | null> {
    const input = this.#input;
    this.#firstTickAt = null;
    const abort = new AbortController();
    this.#abort = abort;
    let attempt: DerivAttempt;
    try {
      // Sin `durationMs`: el cierre previsto es de toda la sesión, nunca de cada conexión por su
      // cuenta (ADR-0015 §4 y §9).
      attempt = await startDerivAttempt({
        ...(input.alert === undefined ? {} : { alert: input.alert }),
        catalog: input.catalog,
        connect: input.connect,
        ingestor,
        nextId: input.nextId,
        now: input.now,
        preparation,
        requestedResponses: input.requestedResponses,
        scheduler: input.scheduler,
        serverTime: input.serverTime,
        signal: abort.signal,
      });
    } catch (error) {
      return integrityEnd(error);
    } finally {
      this.#abort = null;
    }
    if (attempt.status === 'not_connected') {
      // Sin socket: el cierre reparado no quedó durable o un almacén no respondió, y se espera; o
      // llegó la parada, y la espera no empieza.
      return null;
    }
    const { connection } = attempt;
    this.#connection = connection;
    if (this.#stopped) {
      // Una parada que llegó mientras se creaba la conexión, antes de verla aquí.
      connection.stop();
    } else {
      this.#watchGap(connection, ingestor, preparation);
    }
    let result: DerivConnectionResult;
    try {
      result = await attempt.result;
    } catch (error) {
      return integrityEnd(error);
    } finally {
      this.#connection = null;
      // Con la conexión terminada, la recuperación pendiente la pide la siguiente (ADR-0015 §4).
      this.#watch?.cancel();
      this.#watch = null;
    }
    this.#connections.push({
      closure: result.closure,
      connection_id: result.connection_id,
      end: result.end,
    });
    this.#last = result;
    const failure = this.#failure;
    if (failure !== null) {
      if (failure.reason === 'unexpected') {
        throw failure.error;
      }
      return notDerivable(failure.error);
    }
    const { end } = result;
    if (end.status === 'completed') {
      return COMPLETED;
    }
    if (end.status === 'failed') {
      return failed(end.reason, end.detail);
    }
    if (this.#finishAsked) {
      // Después del cierre previsto, como después de la parada, no se reconecta aunque la conexión se
      // perdiera antes de responder `forget_all`: la conexión nueva tendría que recuperar el hueco de
      // esta pérdida, y después de `finish` no empieza ninguna recuperación. La ejecución siguiente lo
      // recupera.
      return COMPLETED;
    }
    // `disconnected` o `paused`: se espera y se reconecta. Después de la parada, la espera no empieza,
    // aunque la conexión no terminara con el cierre pedido.
    if (this.#wasSteady()) {
      this.#attempt = 1;
    }
    return null;
  }

  /**
   * Vigila durante la conexión el hueco pendiente del símbolo y pide su historia por ella, una vez
   * como mucho (ADR-0015 §4, «Cuándo»; ver `GapWatch`). Lee el log del ingestor de la sesión, ya con
   * el cierre reparado del intento, y lo deriva con el perfil de medición; cada derivación sube
   * también el high-watermark del cursor. Cada recuperación pedida entra en el resultado de la
   * sesión.
   */
  #watchGap(
    connection: DerivConnection,
    ingestor: RawFirstIngestor,
    preparation: DerivPreparation,
  ): void {
    const watch: GapWatch = new GapWatch({
      alert: (payload) => {
        this.#alert(payload);
      },
      derive: (segments) => {
        const derived = deriveMarketData(segments, preparation.profile);
        // Todo lo derivado es durable, también un tick que el log adoptó al reabrirse, que no pasó
        // por el sink: el high-watermark del cursor sale también del log (ADR-0015 §3).
        this.#raiseWatermark(latestTickTime(derived.ticks, preparation.symbol));
        return derived;
      },
      onFailure: (failure) => {
        this.#onWatchFailure(watch, failure);
      },
      onSettled: () => {
        this.#onSettled(watch);
      },
      read: () => ingestor.readDurableSegments(),
      recover: (request) => {
        const outcome = connection.recoverHistory(request);
        this.#recoveries.push(outcome);
        return outcome;
      },
      scheduler: this.#input.scheduler,
      symbol: preparation.symbol,
    });
    this.#watch = watch;
    watch.start();
  }

  /**
   * La vigilancia del hueco no puede seguir: para la conexión, y la sesión termina cuando esa
   * conexión termine, con `log_not_derivable` si el log no se puede derivar (ADR-0015 §2) o
   * rechazándose con el error de programación.
   */
  #onWatchFailure(watch: GapWatch, failure: GapWatchFailure): void {
    if (this.#watch !== watch) {
      return;
    }
    this.#failure ??= failure;
    this.#connection?.stop();
  }

  /** Ya no queda recuperación pendiente en la conexión: si el plazo pasó, pide el cierre previsto. */
  #onSettled(watch: GapWatch): void {
    if (this.#due && this.#watch === watch) {
      this.#finish();
    }
  }

  /**
   * Pide el cierre previsto a la conexión en curso; desde entonces la sesión ya no reconecta. Si
   * esa conexión ya había decidido otro cierre, `finish` no hace nada: la sesión la trata como
   * cualquier cierre no pedido, reconecta y pide el cierre previsto a la conexión siguiente cuando
   * termina su recuperación (`#onSettled`).
   */
  #finish(): void {
    if (this.#connection?.finish() === true) {
      this.#finishAsked = true;
    }
  }

  /**
   * El primer tick durable de la sesión pone en marcha el plazo del cierre previsto: `durationMs`
   * después (ADR-0015 §4 y §9). Es el mismo instante desde el que cuenta el corte del smoke, así que
   * un corte menor que la duración llega siempre antes del plazo.
   */
  #armDeadline(): void {
    const { durationMs } = this.#input;
    if (durationMs === undefined || this.#deadlineArmed || this.#stopped) {
      return;
    }
    this.#deadlineArmed = true;
    this.#cancelDeadline = this.#input.scheduler.schedule(durationMs, () => {
      this.#cancelDeadline = null;
      this.#onDeadline();
    });
  }

  /**
   * El plazo del cierre previsto (ADR-0015 §4 y §9): pide `finish` a la conexión en curso, salvo que
   * quede una recuperación pendiente, porque la sesión reconecta tras un cierre no pedido o porque en
   * la conexión en curso se espera el primer tick posterior al cierre, se esperan los 2000 ms o la
   * recuperación corre. Entonces lo pide en cuanto esa recuperación termine (`#onSettled`), también
   * en la conexión siguiente si esta se pierde antes. Espera como mucho 300 000 ms desde el plazo:
   * después, para la sesión, que abandona la recuperación. Después de `finish`, la sesión termina
   * cuando termina esa conexión (`#connect`).
   */
  #onDeadline(): void {
    if (this.#stopped) {
      return;
    }
    this.#due = true;
    this.#cancelBound = this.#input.scheduler.schedule(PLANNED_CLOSE_BOUND_MS, () => {
      this.#cancelBound = null;
      this.stop();
    });
    if (this.#watch?.pending === false) {
      this.#finish();
    }
  }

  /**
   * El primer tick durable de la sesión pone en marcha el corte del smoke de reconexión:
   * `interruptAfterMs` después, una sola vez (ADR-0015 §9). Al cumplirse corta la conexión en
   * curso, si la hay y el plazo del cierre previsto no se cumplió: el corte es para antes de ese
   * cierre.
   */
  #armInterrupt(): void {
    const { interruptAfterMs } = this.#input;
    if (interruptAfterMs === undefined || this.#interruptArmed || this.#stopped) {
      return;
    }
    this.#interruptArmed = true;
    this.#cancelInterrupt = this.#input.scheduler.schedule(interruptAfterMs, () => {
      this.#cancelInterrupt = null;
      if (!this.#due) {
        this.#connection?.interrupt(SMOKE_INTERRUPT_REASON);
      }
    });
  }

  /**
   * Un source event que el ingestor de la sesión acaba de hacer durable. Su conexión es la del
   * cursor; con un log vacío al arrancar, el primero pone en marcha la retención; un
   * `ConnectionOpened` cambia el latido a `connected`, y un `ConnectionClosed`, también uno
   * reparado, escribe el cursor (ADR-0015 §6 y §7).
   */
  #onDurable(event: SourceEvent): void {
    this.#lastConnectionId = event.connection_id;
    this.#armRetention(sourceEventTime(event));
    if (event.kind === 'connection_opened') {
      this.#setConnectionState('connected');
    } else if (event.kind === 'connection_closed') {
      this.#persistCursor();
    }
  }

  /** Sube el high-watermark del cursor a `eventTimeUtc`, si es posterior; nunca lo baja. */
  #raiseWatermark(eventTimeUtc: string | null): void {
    if (
      eventTimeUtc !== null &&
      (this.#highWatermark === null || eventTimeUtc > this.#highWatermark)
    ) {
      this.#highWatermark = eventTimeUtc;
    }
  }

  /**
   * El cursor del símbolo con el estado durable (ADR-0015 §6): la conexión del último evento
   * durable; el segmento abierto, los eventos, el último evento y el último raw del log del
   * ingestor, que tras reabrirse incluye los eventos que adoptó; el high-watermark del símbolo; y la
   * hora. `null` mientras el log no tenga ningún evento.
   */
  #cursor(): IngestionCursor | null {
    const log = this.#ingestor?.log;
    const connectionId = this.#lastConnectionId;
    const preparation = this.#preparation;
    const lastEventId = log?.lastEventId ?? null;
    if (
      log === undefined ||
      lastEventId === null ||
      connectionId === null ||
      preparation === null
    ) {
      return null;
    }
    return {
      active_segment_index: log.openSegmentIndex,
      connection_id: connectionId,
      high_watermark_event_time_utc: this.#highWatermark,
      last_durable_observation_id: log.lastRawObservationId,
      last_durable_source_event_id: lastEventId,
      schema_version: INGESTION_CURSOR_SCHEMA_VERSION,
      source: log.source,
      source_event_count: log.totalEventCount,
      symbol: preparation.symbol,
      updated_at_utc: this.#input.now(),
    };
  }

  /** Escribe el cursor, si hay almacén y el log ya tiene un evento. */
  #persistCursor(): void {
    const { status } = this.#input;
    const cursor = this.#cursor();
    if (status !== undefined && cursor !== null) {
      this.#writeStatus(() => status.appendCursor(cursor));
    }
  }

  /**
   * El latido de arranque y, desde él, uno cada 15 000 ms hasta el final de la sesión (ADR-0015
   * §6). Solo la primera vez, con `status` y un bloqueo que expone su `backendPid`.
   */
  #startHeartbeats(): void {
    if (
      this.#heartbeatsStarted ||
      this.#input.status === undefined ||
      this.#lock?.backendPid === undefined
    ) {
      return;
    }
    this.#heartbeatsStarted = true;
    this.#writeHeartbeat();
    const next = (): void => {
      this.#cancelHeartbeat = this.#input.scheduler.schedule(
        INGESTION_HEARTBEAT_INTERVAL_MS,
        () => {
          this.#writeHeartbeat();
          next();
        },
      );
    };
    next();
  }

  /** Un cambio del estado de la conexión, con su latido (ADR-0015 §6). */
  #setConnectionState(state: IngestionHeartbeat['connection_state']): void {
    this.#connectionState = state;
    this.#writeHeartbeat();
  }

  /**
   * Escribe el latido: la fuente, la ejecución, la hora, el PID del bloqueo, el estado de la
   * conexión y el backlog de la cola de la conexión en curso, o 0 sin ella (ADR-0015 §6). Nunca sin
   * ese bloqueo tomado: lo mira justo antes de escribir, detrás de las escrituras anteriores, así que
   * tampoco si se pierde mientras espera. Un bloqueo perdido no vuelve a estar tomado.
   */
  #writeHeartbeat(): void {
    const { status } = this.#input;
    const lock = this.#lock;
    const pid = lock?.backendPid;
    const source = this.#preparation?.profile.source;
    if (
      status === undefined ||
      this.#runId === null ||
      source === undefined ||
      lock === null ||
      pid === undefined
    ) {
      return;
    }
    const heartbeat: IngestionHeartbeat = {
      backlog_bytes: this.#connection?.backlogBytes ?? 0,
      backlog_count: this.#connection?.backlogCount ?? 0,
      connection_state: this.#connectionState,
      heartbeat_id: this.#input.nextId(),
      observed_at_utc: this.#input.now(),
      pg_backend_pid: pid,
      run_id: this.#runId,
      source,
    };
    this.#writeStatus(() => (lock.held ? status.appendHeartbeat(heartbeat) : Promise.resolve()));
  }

  /**
   * Encadena una escritura del cursor o del latido detrás de las anteriores, para que se guarden en
   * orden. Un fallo no detiene la ingesta, porque no es la durabilidad de los datos: deja la alerta
   * `ingestion_status_unavailable` con el motivo saneado, nunca el mensaje, que en PostgreSQL puede
   * llevar texto del servidor (ADR-0015 §6).
   */
  #writeStatus(write: () => Promise<unknown>): void {
    this.#statusWrites = this.#statusWrites.then(write).then(
      () => undefined,
      (error: unknown) => {
        this.#alert({ event: 'ingestion_status_unavailable', reason: failureReason(error) });
      },
    );
  }

  /** Al terminar: cancela el latido periódico y espera a las escrituras pendientes. */
  async #settleStatus(): Promise<void> {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
    await this.#statusWrites;
  }

  /**
   * Pone en marcha la parada por retención, una sola vez (ADR-0015 §7): cuando el reloj llega a la
   * hora del evento durable más antiguo del log (`oldestUtc`) más `retentionMs`, la sesión para como
   * con `stop` y su resultado lo dice (`stopped_for_retention`). Espera en tramos de 60 000 ms como
   * mucho y vuelve a mirar el reloj después de cada uno. Sin `retentionMs` o tras la parada, no hace
   * nada.
   */
  #armRetention(oldestUtc: string): void {
    const { retentionMs } = this.#input;
    if (retentionMs === undefined || this.#retentionArmed || this.#stopped) {
      return;
    }
    this.#retentionArmed = true;
    const due = Date.parse(oldestUtc) + retentionMs;
    const step = (): void => {
      this.#cancelRetention = null;
      const wait = due - Date.parse(this.#input.now());
      if (wait <= 0) {
        this.#stoppedForRetention = true;
        this.stop();
        return;
      }
      this.#cancelRetention = this.#input.scheduler.schedule(
        Math.min(wait, RETENTION_STEP_MS),
        step,
      );
    };
    step();
  }

  /** Cancela los temporizadores de la sesión: el plazo, su tope, el corte del smoke y la retención. */
  #cancelTimers(): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    this.#cancelBound?.();
    this.#cancelBound = null;
    this.#cancelInterrupt?.();
    this.#cancelInterrupt = null;
    this.#cancelRetention?.();
    this.#cancelRetention = null;
  }

  /**
   * La conexión que acaba de terminar tuvo ticks durables durante 60 000 ms seguidos, desde el
   * primero hasta su fin: el contador de intentos vuelve a 1 (ADR-0015 §3, «Espera»).
   */
  #wasSteady(): boolean {
    const first = this.#firstTickAt;
    return first !== null && Date.parse(this.#input.now()) - first >= STEADY_CONNECTION_MS;
  }

  /**
   * Espera antes del intento siguiente (ADR-0015 §3, «Espera») y la anota en el resultado. Devuelve
   * `false` si llegó la parada, antes o durante la espera, que entonces se corta.
   */
  async #backoff(): Promise<boolean> {
    if (this.#stopped) {
      return false;
    }
    const delay = backoffDelay(this.#attempt, this.#input.random());
    this.#attempt += 1;
    this.#waits.push(delay);
    await new Promise<void>((resolve) => {
      const cancel = this.#input.scheduler.schedule(delay, resolve);
      this.#cancelWait = () => {
        cancel();
        resolve();
      };
    });
    this.#cancelWait = null;
    return !this.#stopped;
  }

  async #releaseLock(): Promise<void> {
    const lock = this.#lock;
    this.#lock = null;
    await lock?.release();
  }
}

/**
 * La sesión de ingesta de Deriv (ADR-0015 §3, §4 y §5). Prepara los esquemas una vez, toma el
 * bloqueo de la fuente, abre el log con él y lo comprueba, y sigue una conexión por intento con un
 * solo `RawFirstIngestor`: tras una conexión que se pierde o se pausa, o un intento que no conecta,
 * espera y lo intenta otra vez, con un bloqueo nuevo si perdió el suyo. En cada conexión pide la
 * historia del hueco pendiente, 2000 ms después del primer tick durable posterior al cierre. Termina
 * con la parada, la retención (`retentionMs`, ADR-0015 §7) o el cierre previsto por `durationMs`
 * (`completed`), o cuando no puede seguir sin intervención (`failed`). Con `interruptAfterMs`, corta
 * una vez su conexión, como el smoke de reconexión (ADR-0015 §9). Con `status`, comprueba el log
 * contra el cursor al arrancar y escribe el cursor y el latido (ADR-0015 §5 y §6). Al terminar
 * cierra el segmento abierto, si el log está sano y el bloqueo sigue tomado, escribe el cursor una
 * última vez, espera a las escrituras pendientes y suelta el bloqueo. Un `durationMs`, un
 * `interruptAfterMs` o un `retentionMs` que no es un entero positivo de milisegundos es un error de
 * programación: lanza `TypeError` sin empezar nada.
 */
export function startDerivSession(input: DerivSessionInput): DerivSession {
  if (input.durationMs !== undefined) {
    assertDuration(input.durationMs);
  }
  const { interruptAfterMs, retentionMs } = input;
  if (
    interruptAfterMs !== undefined &&
    !(Number.isSafeInteger(interruptAfterMs) && interruptAfterMs > 0)
  ) {
    throw new TypeError('interruptAfterMs debe ser un entero positivo de milisegundos.');
  }
  if (retentionMs !== undefined && !(Number.isSafeInteger(retentionMs) && retentionMs > 0)) {
    throw new TypeError('retentionMs debe ser un entero positivo de milisegundos.');
  }
  const run = new SessionRun(input);
  return {
    done: run.done,
    stop: () => {
      run.stop();
    },
  };
}
