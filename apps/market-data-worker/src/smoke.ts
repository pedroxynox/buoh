import { type ConnectionClosed } from '@buoh/contracts';
import { type InvalidFrameReason } from '@buoh/domain';

import { runDerivAdapter } from './deriv/adapter.js';
import { type DerivSessionEnd } from './deriv/connection.js';
import { type Scheduler } from './deriv/ports.js';
import { DERIV_CONNECTOR_VERSION, DERIV_SOURCE } from './deriv/profile.js';
import { type ExpectedSchemaArchive } from './deriv/schema-archive.js';
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

/**
 * Resultado saneado del smoke (ADR-0012 §10): solo tiempos, conteos, códigos y hashes. Nunca lleva
 * payloads ni precios.
 */
export interface SmokeReport {
  readonly catalog: { readonly content_sha256: string; readonly entry_count: number } | null;
  readonly closure: {
    readonly closure_type: ConnectionClosed['closure_type'];
    readonly persisted: boolean;
    readonly reason: string;
  } | null;
  readonly connector_version: string;
  /** Recepción menos la hora del tick, sin el primer tick de la suscripción. */
  readonly delivery_delay_ms: Distribution | null;
  readonly duration_seconds: number;
  readonly end: DerivSessionEnd;
  readonly finished_at_utc: string;
  /**
   * Retraso del primer tick de la suscripción. Va aparte porque puede ser un tick que Deriv ya
   * tenía al suscribirse, así que su retraso puede incluir su antigüedad.
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
  readonly note: string;
  readonly schemas: { readonly archive_sha256: string; readonly release: string } | null;
  /** Recepción local menos la hora del servidor (`time`), o `null` si no se obtuvo. */
  readonly server_time_offset_ms: number | null;
  readonly source: string;
  readonly source_time_resolution_ms: number;
  readonly started_at_utc: string;
  readonly status: 'failed' | 'passed';
  readonly symbol: string;
  /** Nombre oficial del símbolo en el catálogo recibido, sin traducir. */
  readonly symbol_name: string | null;
  /** Intervalo entre las horas de ticks consecutivos. */
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

export interface SmokeInput {
  readonly alert?: OperationalAlert;
  readonly connect: SocketFactory;
  readonly durationSeconds: number;
  /** Archivo de esquemas esperado; por defecto, la release fijada. */
  readonly expected?: ExpectedSchemaArchive;
  readonly fetch: typeof fetch;
  readonly nextId: () => string;
  readonly now: () => string;
  readonly scheduler: Scheduler;
  readonly schemaUrl?: string;
  readonly symbol: string;
  /** Versión de zlib del writer gzip de segmentos. */
  readonly zlibVersion: string;
}

/**
 * `pnpm run data:smoke` (ADR-0012 §10): una conexión al canal público de Deriv con el perfil de
 * medición y almacenamiento en memoria de este proceso. Nada se escribe en disco, PostgreSQL ni
 * almacenamiento de objetos, y todo se borra al terminar (ADR-0004 §13). Pasa si la conexión termina
 * con el cierre previsto y llegó al menos un tick.
 */
export async function runSmoke(input: SmokeInput): Promise<SmokeReport> {
  const startedAt = input.now();
  const objects = new InMemoryObjectStore('buoh-smoke');
  const sourceLog = new InMemorySourceLogStore();
  const operational = new InMemoryOperationalStore();
  const requested = new InMemoryRequestedResponseIncidentStore();
  const openLog = () =>
    SourceEventLog.open({
      objects,
      source: DERIV_SOURCE,
      store: sourceLog,
      zlibVersion: input.zlibVersion,
    });
  const registry = await OperationalRegistry.open({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    source: DERIV_SOURCE,
    store: operational,
  });

  // Solo los tiempos de cada tick: el precio nunca sale del log en memoria.
  const tickTimes: { readonly event: number; readonly received: number }[] = [];
  const invalid: InvalidFrameReason[] = [];
  const nonTick: string[] = [];
  const result = await runDerivAdapter({
    ...(input.alert === undefined ? {} : { alert: input.alert }),
    catalog: new InMemoryCatalogStore(),
    connect: input.connect,
    durationMs: input.durationSeconds * 1000,
    ...(input.expected === undefined ? {} : { expected: input.expected }),
    fetch: input.fetch,
    log: await openLog(),
    nextId: input.nextId,
    now: input.now,
    registry,
    reopenLog: openLog,
    requestedResponses: requested,
    scheduler: input.scheduler,
    ...(input.schemaUrl === undefined ? {} : { schemaUrl: input.schemaUrl }),
    serverTime: true,
    sink: {
      invalidFrame: ({ reason }) => invalid.push(reason),
      nonTickFrame: ({ msg_type }) => nonTick.push(msg_type),
      tick: (tick) =>
        tickTimes.push({
          event: Date.parse(tick.event_time_utc),
          received: Date.parse(tick.received_at_utc),
        }),
    },
    symbol: input.symbol,
  });
  const finishedAt = input.now();

  const snapshot = result.catalog?.snapshot ?? null;
  const passed = result.end.status === 'completed' && tickTimes.length > 0;
  const delays = tickTimes.map((tick) => tick.received - tick.event);
  return {
    catalog:
      snapshot === null
        ? null
        : { content_sha256: snapshot.content_sha256, entry_count: snapshot.entry_count },
    closure: result.closure,
    connector_version: DERIV_CONNECTOR_VERSION,
    delivery_delay_ms: distribution(delays.slice(1)),
    duration_seconds: input.durationSeconds,
    end: result.end,
    finished_at_utc: finishedAt,
    first_tick_delay_ms: delays[0] ?? null,
    frames: {
      invalid: invalid.length,
      non_tick: tally(nonTick),
      raw: sourceLog.rows.filter((row) => row.kind === 'raw_source_frame').length,
      ticks: tickTimes.length,
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
    note: SMOKE_NOTE,
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
      tickTimes.slice(1).map((tick, index) => tick.event - (tickTimes[index]?.event ?? tick.event)),
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
  dependencies: Omit<SmokeInput, 'durationSeconds' | 'symbol'>,
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
