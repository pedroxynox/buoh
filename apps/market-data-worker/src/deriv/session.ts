import { type SourceEvent } from '@buoh/contracts';
import { deriveMarketData, type DerivedMarketData } from '@buoh/domain';

import { RawFirstIngestor } from '../ingestion/raw-first-ingestor.js';
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
   * `startDerivSession` lanza `TypeError`. Cuenta desde el primer `ConnectionOpened` durable de la
   * sesión, y al cumplirse la sesión pide el cierre previsto (`finish`) a la conexión en curso. Si
   * queda una recuperación de historia pendiente, lo pide después de su resultado, como mucho
   * 300 000 ms después del plazo; pasado ese tope, para. Después de `finish` no reconecta ni pide más
   * historia. Es de la sesión, nunca de una conexión: la sesión no la pasa a sus conexiones. Sin
   * ella, la sesión sigue hasta la parada o un fallo.
   */
  readonly durationMs?: number;
}

/** Una conexión de la sesión: su ID (`null` si no llegó a abrirse), su cierre y cómo terminó. */
export interface DerivSessionConnection {
  readonly closure: DerivConnectionResult['closure'];
  readonly connection_id: string | null;
  readonly end: DerivSessionEnd;
}

export interface DerivSessionResult {
  /** Catálogo vigente de la última conexión, o `null`. */
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
  /** Desfase con el servidor medido en la última conexión, o `null`. */
  readonly server_time_offset_ms: number | null;
  /** `subscription.id` de la última conexión, o `null`. */
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

/**
 * Las comprobaciones del log antes de conectar que no necesitan el cursor (ADR-0015 §5): todos sus
 * frames son de este conector, se deriva con el perfil de medición y sus ticks son del símbolo
 * pedido. Devuelve el fin `failed`, o `null` si las pasa.
 */
function checkLog(
  segments: readonly (readonly SourceEvent[])[],
  preparation: DerivPreparation,
): SessionEnd | null {
  const { profile } = preparation;
  const foreign = segments.some((segment) =>
    segment.some(
      (event) =>
        event.kind === 'raw_source_frame' && event.connector_version !== profile.connector_version,
    ),
  );
  if (foreign) {
    return failed('connector_version_mismatch');
  }
  let derived: DerivedMarketData;
  try {
    derived = deriveMarketData(segments, profile);
  } catch (error) {
    return notDerivable(error);
  }
  // El perfil admite solo el símbolo pedido, así que todo tick derivado es de ese símbolo: un tick de
  // otro símbolo queda como frame inválido con `symbol_not_allowed`.
  const otherSymbol = derived.incidents.some(
    (incident) =>
      incident.incident_type === 'invalid_source_frame' &&
      incident.evidence.reason === 'symbol_not_allowed',
  );
  return otherSymbol ? failed('symbol_mismatch') : null;
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
  /** Ya empezó a contar el plazo del cierre previsto. */
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

  constructor(input: DerivSessionInput) {
    this.#input = input;
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
    this.#cancelPlannedClose();
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
      this.#cancelPlannedClose();
      await this.#releaseLock();
      throw error;
    }
    this.#cancelPlannedClose();
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
      }
    } finally {
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
    const opened = await this.#openLog(preparation);
    if ('end' in opened) {
      return opened.end;
    }
    const { log } = opened;
    const ingestor = new RawFirstIngestor({
      log,
      nextId: input.nextId,
      now: input.now,
      profile: preparation.profile,
      registry: input.registry,
      onConnectionOpened: () => {
        this.#onConnectionOpened();
      },
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
          input.sink.tick(tick);
          // Ya durable: si es posterior al high-watermark del hueco, la sesión vuelve a derivar.
          this.#watch?.onTick(tick);
        },
      },
    });
    this.#ingestor = ingestor;
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
   * Toma el bloqueo, abre el log con él, lo lee entero y lo comprueba antes de conectar (ADR-0015
   * §5). Si un almacén no responde, espera y lo intenta otra vez, con un bloqueo nuevo si mientras
   * tanto se perdió. Si el contenido no pasa sus comprobaciones, el fin es `log_not_derivable`.
   */
  async #openLog(
    preparation: DerivPreparation,
  ): Promise<{ readonly end: SessionEnd } | { readonly log: SourceEventLog }> {
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
      const end = checkLog(segments, preparation);
      return end === null ? { log } : { end };
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
   * Un intento y su conexión. Devuelve el fin de la sesión según cómo terminó la conexión
   * (ADR-0015 §3), o `null` para esperar y reconectar: no conectó, o la conexión terminó
   * `disconnected` o `paused`.
   */
  async #connect(
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
   * el cierre reparado del intento, y lo deriva con el perfil de medición. Cada recuperación pedida
   * entra en el resultado de la sesión.
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
      derive: (segments) => deriveMarketData(segments, preparation.profile),
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
   * El primer `ConnectionOpened` durable de la sesión pone en marcha el plazo del cierre previsto:
   * `durationMs` después (ADR-0015 §4 y §9).
   */
  #onConnectionOpened(): void {
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

  #cancelPlannedClose(): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    this.#cancelBound?.();
    this.#cancelBound = null;
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
 * con la parada o el cierre previsto por `durationMs` (`completed`), o cuando no puede seguir sin
 * intervención (`failed`). Al terminar cierra el segmento abierto, si el log está sano y el bloqueo
 * sigue tomado, y suelta el bloqueo. Un `durationMs` que no es un entero positivo de milisegundos es
 * un error de programación: lanza `TypeError` sin empezar nada.
 */
export function startDerivSession(input: DerivSessionInput): DerivSession {
  if (input.durationMs !== undefined) {
    assertDuration(input.durationMs);
  }
  const run = new SessionRun(input);
  return {
    done: run.done,
    stop: () => {
      run.stop();
    },
  };
}
