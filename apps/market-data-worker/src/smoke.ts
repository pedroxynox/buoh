import { type ConnectionClosed, type HistoryRecoveryResult } from '@buoh/contracts';
import { type InvalidFrameReason } from '@buoh/domain';

import { type HistoryRecoveryOutcome } from './deriv/history-recovery.js';
import { type Scheduler } from './deriv/ports.js';
import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from './deriv/profile.js';
import { type ExpectedSchemaArchive } from './deriv/schema-archive.js';
import {
  SMOKE_INTERRUPT_REASON,
  startDerivSession,
  type DerivSessionConnection,
  type DerivSessionResult,
  type SessionLockProvider,
} from './deriv/session.js';
import { type SocketFactory } from './deriv/socket.js';
import {
  InMemoryCatalogStore,
  InMemoryObjectStore,
  InMemoryOperationalStore,
  InMemoryRequestedResponseIncidentStore,
  InMemorySourceLogStore,
} from './memory/stores.js';
import { OperationalRegistry, type OperationalAlert } from './operational/registry.js';
import { UsageError } from './replay-args.js';
import { parseSmokeArgs } from './smoke-args.js';
import { SourceEventLog } from './source-log/source-event-log.js';

/** Resolución del tiempo de Deriv: segundos enteros. */
export const DERIV_TIME_RESOLUTION_MS = 1000;

export const SMOKE_NOTE =
  'Deriv da sus horas en segundos enteros: el retraso y el desfase medidos pueden superar a los reales hasta en 999 ms. El primer tick de la suscripción va aparte, porque puede ser uno que Deriv ya tenía.';

/** Mínimo, percentiles por rango más cercano y máximo, en milisegundos. */
export interface Distribution {
  readonly count: number;
  readonly max: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
}

/** Una recuperación de historia en el resultado del smoke: sin horas ni precios. */
export interface SmokeRecovery {
  /** Intentos hechos, de 1 a 3. */
  readonly attempts: number;
  /** Páginas pedidas en el último intento. */
  readonly pages: number;
  /** Motivo de `partial` o `unavailable`; `null` con `complete`. */
  readonly reason: string | null;
  /** Ticks recuperados entre los dos extremos; `null` con `unavailable`. */
  readonly recovered_event_count: number | null;
  readonly status: HistoryRecoveryResult['status'];
}

/**
 * Resultado saneado del smoke (ADR-0012 §10 y ADR-0015 §9): solo tiempos, conteos, códigos y
 * hashes. Nunca lleva payloads ni precios.
 */
export interface SmokeReport {
  /** Catálogo vigente de la última conexión. */
  readonly catalog: { readonly content_sha256: string; readonly entry_count: number } | null;
  /** Cierre del último intento de conexión, o `null` si ese intento no llegó a abrirse. */
  readonly closure: {
    readonly closure_type: ConnectionClosed['closure_type'];
    readonly persisted: boolean;
    readonly reason: string;
  } | null;
  /**
   * Las conexiones que llegaron a abrirse (con `connection_id`). Un intento que no abrió no cuenta;
   * se ve en `reconnect_waits_ms` y, si fue el último, en `closure` `null`.
   */
  readonly connections: number;
  readonly connector_version: string;
  /** Recepción menos la hora del tick, sin el primer tick de cada suscripción. */
  readonly delivery_delay_ms: Distribution | null;
  readonly duration_seconds: number;
  /**
   * Cómo terminó la sesión (`DerivSessionResult.end`). Si el smoke la paró porque a la duración
   * pedida no había abierto ninguna conexión y la sesión terminó `completed`, es `failed` con
   * `never_connected`, y `detail` es el motivo del último intento que terminó por su cuenta (por
   * ejemplo `connect_failed` o `connect_timeout`) o `null`.
   */
  readonly end: DerivSessionResult['end'];
  readonly finished_at_utc: string;
  /**
   * Retraso del primer tick de la primera suscripción. Va aparte porque puede ser un tick que Deriv
   * ya tenía al suscribirse, así que su retraso puede incluir su antigüedad.
   */
  readonly first_tick_delay_ms: number | null;
  readonly frames: {
    readonly invalid: number;
    /** Respuestas pedidas que no son ticks, por `msg_type`. */
    readonly non_tick: Readonly<Record<string, number>>;
    /** Frames de texto durables en el log. */
    readonly raw: number;
    /** Ticks normalizados. */
    readonly ticks: number;
  };
  readonly incidents: {
    /** Frames inválidos según las reglas 2.0.0, por motivo. */
    readonly invalid_frames: Readonly<Record<string, number>>;
    /** Registro operativo (límites o persistencia), por tipo. */
    readonly operational: Readonly<Record<string, number>>;
    /** Respuestas pedidas inválidas (ADR-0012 §6), por motivo. */
    readonly requested_responses: Readonly<Record<string, number>>;
  };
  /** El corte pedido con `--interrupt-after-seconds`, en segundos, o `null`. */
  readonly interrupt_after_seconds: number | null;
  readonly note: string;
  /** Las esperas antes de cada reintento, en milisegundos y en orden. */
  readonly reconnect_waits_ms: readonly number[];
  /**
   * Las conexiones abiertas después de la primera. La sesión solo vuelve a conectar después de una
   * conexión que terminó sin el cierre previsto (`disconnected` o `paused`), también la del corte.
   * Un intento que no llegó a abrirse no cuenta.
   */
  readonly reconnections: number;
  /** La última recuperación de historia cuyo resultado quedó en el log, o `null`. */
  readonly recovery: SmokeRecovery | null;
  readonly schemas: { readonly archive_sha256: string; readonly release: string } | null;
  /**
   * Recepción local menos la hora del servidor (`time`) en la última conexión, o `null` si no se
   * obtuvo.
   */
  readonly server_time_offset_ms: number | null;
  readonly source: string;
  readonly source_time_resolution_ms: number;
  readonly started_at_utc: string;
  readonly status: 'failed' | 'passed';
  readonly symbol: string;
  /** Nombre oficial del símbolo en el catálogo de la última conexión, sin traducir. */
  readonly symbol_name: string | null;
  /** Intervalo entre las horas de ticks consecutivos de una misma suscripción. */
  readonly tick_interval_ms: Distribution | null;
}

/** Distribución de `values`, o `null` si no hay ninguno. */
export function distribution(values: readonly number[]): Distribution | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0;
  return {
    count: sorted.length,
    max: sorted.at(-1) ?? 0,
    min: sorted[0] ?? 0,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
  };
}

function tally(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of [...keys].sort()) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * La última recuperación de historia cuyo resultado quedó en el log (`finished` y `durable`), o
 * `null`. Una `abandoned` no cuenta, porque puede no haber pedido ninguna página, ni una cuyo
 * resultado no quedó durable.
 */
export function lastDurableRecovery(
  outcomes: readonly HistoryRecoveryOutcome[],
): SmokeRecovery | null {
  const outcome = outcomes.findLast((item) => item.status === 'finished' && item.durable);
  if (outcome?.status !== 'finished') {
    return null;
  }
  const { result } = outcome;
  return {
    attempts: outcome.attempts,
    pages: outcome.pages,
    reason: result.status === 'complete' ? null : result.reason,
    recovered_event_count: result.status === 'unavailable' ? null : result.recovered_event_count,
    status: result.status,
  };
}

/**
 * El bloqueo de la fuente del smoke: siempre tomado. El smoke guarda todo en la memoria de su
 * proceso, así que ningún otro proceso escribe su log (ADR-0012 §10).
 */
const SMOKE_LOCK: SessionLockProvider = {
  acquire: () => Promise.resolve({ held: true, release: () => Promise.resolve() }),
};

/** Motivo del fin cuando el smoke para una sesión que no abrió ninguna conexión a tiempo. */
const NEVER_CONNECTED = 'never_connected';

/**
 * El motivo del fin del último intento que terminó por su cuenta, o `null`. Un intento en curso que
 * corta la parada del smoke termina `completed`, sin motivo, y no cuenta.
 */
function lastAttemptReason(connections: readonly DerivSessionConnection[]): string | null {
  const end = connections.findLast((connection) => connection.end.status !== 'completed')?.end;
  return end === undefined || end.status === 'completed' ? null : end.reason;
}

/** Las horas de un tick, en ms desde la época: el precio nunca sale del log en memoria. */
interface TickTimes {
  readonly event: number;
  readonly received: number;
}

export interface SmokeInput {
  readonly alert?: OperationalAlert;
  readonly connect: SocketFactory;
  /**
   * Duración de la sesión, desde su primera apertura durable. También es el límite para conectar:
   * si a esa duración desde el inicio del smoke el log no tiene ningún `ConnectionOpened`, el smoke
   * para la sesión y falla con `never_connected`.
   */
  readonly durationSeconds: number;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  /**
   * El corte del smoke de reconexión (ADR-0015 §9), en segundos desde el primer tick durable: un
   * entero desde 1 y menor que la duración. Sin él (o con `null`), no corta.
   */
  readonly interruptAfterSeconds?: number | null;
  readonly nextId: () => string;
  readonly now: () => string;
  /** Azar de la espera entre intentos, en [0, 1). */
  readonly random: () => number;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
  readonly symbol: string;
  /** Versión de zlib del writer gzip de segmentos. */
  readonly zlibVersion: string;
}

/**
 * `pnpm run data:smoke` (ADR-0012 §10 y ADR-0015 §9): la sesión de ingesta contra el canal público
 * de Deriv, con el perfil de medición, almacenamiento en memoria de este proceso, un bloqueo en
 * memoria siempre tomado y el cierre previsto a la duración pedida. Nada se escribe en disco,
 * PostgreSQL ni almacenamiento de objetos, y todo se borra al terminar (ADR-0004 §13). Una
 * desconexión no prevista se reconecta y se recupera; con `interruptAfterSeconds`, la sesión
 * corta su propio socket una vez. Si a la duración pedida desde su inicio todavía no abrió ninguna
 * conexión, el smoke para la sesión y falla con `never_connected`. Pasa si la sesión terminó
 * `completed`, llegó al menos un tick y el último intento cerró con el cierre previsto, que quedó
 * en el log. Además, sin corte, no hubo ninguna reconexión; con él, hubo exactamente una, la que
 * siguió al corte de la primera conexión abierta, y la última recuperación que quedó en el log es
 * `complete`. Un intento que no llegó a abrirse no cuenta como conexión ni como reconexión.
 */
export async function runSmoke(input: SmokeInput): Promise<SmokeReport> {
  const startedAt = input.now();
  const objects = new InMemoryObjectStore('buoh-smoke');
  const sourceLog = new InMemorySourceLogStore();
  const operational = new InMemoryOperationalStore();
  const requested = new InMemoryRequestedResponseIncidentStore();
  const registry = await OperationalRegistry.open({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    source: DERIV_SOURCE,
    store: operational,
  });

  // Los ticks, por suscripción. Cada conexión pide el catálogo una vez, antes de suscribirse, así
  // que el primer tick después de cada catálogo es el primero de una suscripción.
  const subscriptions: TickTimes[][] = [];
  let subscribing = true;
  const invalid: InvalidFrameReason[] = [];
  const nonTick: string[] = [];
  const interruptAfterSeconds = input.interruptAfterSeconds ?? null;
  const session = startDerivSession({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    catalog: new InMemoryCatalogStore(),
    connect: input.connect,
    durationMs: input.durationSeconds * 1000,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    fetch: input.fetch,
    ...(interruptAfterSeconds === null ? {} : { interruptAfterMs: interruptAfterSeconds * 1000 }),
    lock: SMOKE_LOCK,
    nextId: input.nextId,
    now: input.now,
    openLog: () =>
      SourceEventLog.open({
        objects,
        source: DERIV_SOURCE,
        store: sourceLog,
        zlibVersion: input.zlibVersion,
      }),
    random: input.random,
    registry,
    requestedResponses: requested,
    scheduler: input.scheduler,
    ...(input.schemaUrl === undefined ? {} : { schemaUrl: input.schemaUrl }),
    serverTime: true,
    sink: {
      invalidFrame: ({ reason }) => invalid.push(reason),
      nonTickFrame: ({ msg_type }) => {
        nonTick.push(msg_type);
        if (msg_type === 'active_symbols') {
          subscribing = true;
        }
      },
      tick: (tick) => {
        if (subscribing) {
          subscriptions.push([]);
          subscribing = false;
        }
        subscriptions.at(-1)?.push({
          event: Date.parse(tick.event_time_utc),
          received: Date.parse(tick.received_at_utc),
        });
      },
    },
    symbol: input.symbol,
  });
  // El plazo del cierre previsto solo empieza con la primera apertura durable: sin ella, la sesión
  // lo intentaría sin fin. Si a la duración pedida desde el inicio del smoke el log todavía no
  // tiene ningún `ConnectionOpened`, el smoke para la sesión.
  const connectBound = { fired: false };
  const cancelConnectBound = input.scheduler.schedule(input.durationSeconds * 1000, () => {
    if (!sourceLog.rows.some((row) => row.kind === 'connection_opened')) {
      connectBound.fired = true;
      session.stop();
    }
  });
  const result = await session.done.finally(cancelConnectBound);
  const finishedAt = input.now();
  // La parada del límite deja la sesión `completed`; un fin `failed` conserva su motivo.
  const end: SmokeReport['end'] =
    connectBound.fired && result.end.status === 'completed'
      ? {
          detail: lastAttemptReason(result.connections),
          reason: NEVER_CONNECTED,
          status: 'failed',
        }
      : result.end;

  // Un intento que no llegó a abrirse no es una conexión: no tuvo cierre, así que tampoco deja una
  // reconexión. El cierre del resultado es el del último intento.
  const closure = result.connections.at(-1)?.closure ?? null;
  const opened = result.connections.filter((connection) => connection.connection_id !== null);
  const reconnections = Math.max(0, opened.length - 1);
  const recovery = lastDurableRecovery(result.recoveries);
  const ticks = subscriptions.reduce((count, times) => count + times.length, 0);
  const plannedClose =
    closure?.closure_type === 'requested' && closure.reason === 'requested' && closure.persisted;
  const reconnectedAsAsked =
    interruptAfterSeconds === null
      ? reconnections === 0
      : reconnections === 1 &&
        opened[0]?.closure?.reason === SMOKE_INTERRUPT_REASON &&
        recovery?.status === 'complete';
  const passed = end.status === 'completed' && ticks > 0 && plannedClose && reconnectedAsAsked;
  const delay = (tick: TickTimes) => tick.received - tick.event;
  const firstTick = subscriptions[0]?.[0];
  const snapshot = result.catalog?.snapshot ?? null;
  return {
    catalog:
      snapshot === null
        ? null
        : { content_sha256: snapshot.content_sha256, entry_count: snapshot.entry_count },
    closure,
    connections: opened.length,
    connector_version: DERIV_CONNECTOR_VERSION,
    delivery_delay_ms: distribution(subscriptions.flatMap((times) => times.slice(1).map(delay))),
    duration_seconds: input.durationSeconds,
    end,
    finished_at_utc: finishedAt,
    first_tick_delay_ms: firstTick === undefined ? null : delay(firstTick),
    frames: {
      invalid: invalid.length,
      non_tick: tally(nonTick),
      raw: sourceLog.rows.filter((row) => row.kind === 'raw_source_frame').length,
      ticks,
    },
    incidents: {
      invalid_frames: tally(invalid),
      operational: tally(operational.incidents.map((incident) => incident.incident_type)),
      requested_responses: tally(
        requested.incidents.map((incident) =>
          'reason' in incident.evidence ? incident.evidence.reason : incident.incident_type,
        ),
      ),
    },
    interrupt_after_seconds: interruptAfterSeconds,
    note: SMOKE_NOTE,
    reconnect_waits_ms: result.waits_ms,
    reconnections,
    recovery,
    schemas: result.schemas,
    server_time_offset_ms: result.server_time_offset_ms,
    source: DERIV_SOURCE,
    source_time_resolution_ms: DERIV_TIME_RESOLUTION_MS,
    started_at_utc: startedAt,
    status: passed ? 'passed' : 'failed',
    symbol: input.symbol,
    symbol_name:
      snapshot?.entries.find((entry) => entry.underlying_symbol === input.symbol)
        ?.underlying_symbol_name ?? null,
    tick_interval_ms: distribution(
      subscriptions.flatMap((times) =>
        times.slice(1).map((tick, index) => tick.event - (times[index]?.event ?? tick.event)),
      ),
    ),
  };
}

/**
 * Código de salida del smoke (ADR-0012 §10): 0 si pasa, 1 si falla y 2 si es un error de uso. Un
 * símbolo que el esquema de la petición `ticks` no admite es un error de uso, aunque se detecte
 * después de cargar los esquemas.
 */
export function smokeExitCode(report: SmokeReport): 0 | 1 | 2 {
  if (report.status === 'passed') {
    return 0;
  }
  return report.end.status === 'failed' && report.end.reason === 'request_invalid' ? 2 : 1;
}

/**
 * El comando completo, sin efectos propios: interpreta los argumentos, corre el smoke y devuelve
 * la línea JSON y el código de salida. Un error inesperado da `code: UNEXPECTED` y salida 1.
 */
export async function smokeCommand(
  argv: readonly string[],
  dependencies: Omit<SmokeInput, 'durationSeconds' | 'interruptAfterSeconds' | 'symbol'>,
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly line: string }> {
  let options;
  try {
    options = parseSmokeArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      return {
        exitCode: 2,
        line: JSON.stringify({ code: error.name, message: error.message, status: 'failed' }),
      };
    }
    throw error;
  }
  try {
    const report = await runSmoke({
      ...dependencies,
      durationSeconds: options.durationSeconds,
      interruptAfterSeconds: options.interruptAfterSeconds,
      symbol: options.symbol,
    });
    return { exitCode: smokeExitCode(report), line: JSON.stringify(report) };
  } catch (error) {
    return {
      exitCode: 1,
      line: JSON.stringify({
        code: 'UNEXPECTED',
        message: error instanceof Error ? error.name : 'Error',
        status: 'failed',
      }),
    };
  }
}
