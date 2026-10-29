import {
  type ConditionType,
  type HealthReport,
  type ServiceHealth,
  type SourceEvent,
} from '@buoh/contracts';
import {
  deriveHealthReport,
  unobservedHealthReport,
  type DerivedMarketData,
  type PipelineProfile,
} from '@buoh/domain';

import { checkLogContent, isOtherSymbol } from '../deriv/log-check.js';
import { type IngestionHeartbeat } from '../ingestion/status.js';
import { previousConnection, unrecordedClose } from '../source-log/previous-connection.js';

/** Lo observado de una fuente que se pudo leer entera (ADR-0015 §8, «Entradas»). */
export interface ObservedSource {
  /** Los símbolos que tienen algún cursor de la fuente (`IngestionStatusStore.cursorSymbols`). */
  readonly cursorSymbols: readonly string[];
  /** El `dataset_id` del último dataset activo de la fuente en el entorno, o `null`. */
  readonly lastPublishedDatasetId: string | null;
  /** El último latido escrito de la fuente (`IngestionStatusStore.latestHeartbeat`), o `null`. */
  readonly latestHeartbeat: IngestionHeartbeat | null;
  /** UUIDv7 para el cierre que la regla 4 añade en memoria. */
  readonly nextId: () => string;
  /** La hora de la observación, UTC con milisegundos. */
  readonly now: string;
  /** Los tipos abiertos del registro operativo. */
  readonly operationalConditionTypes: readonly ConditionType[];
  /**
   * El perfil de medición del símbolo, con el esquema de fuente que guardó la ingesta, o `null` si
   * no hay esquema guardado.
   */
  readonly profile: PipelineProfile | null;
  /** El log durable: sus segmentos, cerrados y abierto, en orden. */
  readonly segments: readonly (readonly SourceEvent[])[];
  readonly source: string;
  readonly status: 'observed';
  /** El símbolo pedido. */
  readonly symbol: string;
  /** El PID de la sesión de PostgreSQL que tiene el bloqueo de la fuente según `pg_locks`, o `null`. */
  readonly writerPid: number | null;
}

/**
 * Lo que observó `data:health` (ADR-0015 §8). Quien lee los almacenes decide los dos primeros casos,
 * con un motivo saneado (un código o un nombre, nunca el mensaje de un error):
 * `storage_unavailable` si PostgreSQL o el almacenamiento de objetos no responden (regla 3), e
 * `incompatible` si lo leído ya es incompatible (regla 2), como un esquema de fuente guardado que
 * falta o que no coincide con su SHA-256 fijado.
 */
export type HealthObservation =
  | { readonly reason: string; readonly source: string; readonly status: 'incompatible' }
  | { readonly reason: string; readonly source: string; readonly status: 'storage_unavailable' }
  | ObservedSource;

/** La alerta de stderr de las reglas 2 y 3, con el motivo saneado. */
export interface HealthAlert {
  readonly event: 'data_health_failed' | 'data_health_storage_unavailable';
  readonly reason: string;
}

export interface HealthEvaluation {
  /** La alerta de las reglas 2 y 3, o `null`. */
  readonly alert: HealthAlert | null;
  /** 0 si la salud es `healthy` y 1 si es otra (ADR-0015 §8, «Salida»). */
  readonly exitCode: 0 | 1;
  readonly report: HealthReport;
}

/** Regla 2: lo observado es incompatible. Nada de lo observado es fiable. */
function failedEvaluation(source: string, reason: string): HealthEvaluation {
  return {
    alert: { event: 'data_health_failed', reason },
    exitCode: 1,
    report: unobservedHealthReport({ service_health: 'failed', source }),
  };
}

/** La derivación del log, o el motivo de la regla 2 que no pasa. */
type ObservedLogCheck =
  | { readonly derived: DerivedMarketData; readonly status: 'passed' }
  | { readonly reason: string; readonly status: 'failed' };

/** La derivación de un log vacío: sin eventos no hay nada que derivar, ni hace falta el perfil. */
function emptyDerivation(): DerivedMarketData {
  return {
    conditions: [],
    incidents: [],
    openConditionTypes: [],
    pendingContinuitySymbols: [],
    pendingGaps: [],
    ticks: [],
  };
}

/**
 * Las comprobaciones de la regla 2 sobre el log que se deriva. Con el esquema de fuente guardado, son
 * las del arranque de la sesión (`checkLogContent`). Sin él, un log no vacío no se puede derivar
 * (`source_schema_missing`), y uno vacío solo se comprueba con los cursores de la fuente.
 */
function checkObservedLog(
  observation: ObservedSource,
  segments: readonly (readonly SourceEvent[])[],
): ObservedLogCheck {
  const { cursorSymbols, profile, symbol } = observation;
  if (profile !== null) {
    return checkLogContent({ cursorSymbols, profile, segments, symbol });
  }
  if (segments.some((segment) => segment.length > 0)) {
    return { reason: 'source_schema_missing', status: 'failed' };
  }
  const derived = emptyDerivation();
  return isOtherSymbol({ cursorSymbols, derived, symbol })
    ? { reason: 'symbol_mismatch', status: 'failed' }
    : { derived, status: 'passed' };
}

/**
 * Lo que da la regla del escritor que se aplica (ADR-0015 §8, reglas 4 a 6): el backlog, la conexión
 * si no sale del log y la salud mínima.
 */
interface WriterView {
  readonly backlog_bytes: number;
  readonly backlog_count: number;
  /** La conexión observada fuera del log; sin ella, sale del log. */
  readonly connection_state?: HealthReport['connection_state'];
  readonly minimum_health?: ServiceHealth;
  readonly rule: 4 | 5 | 6;
}

/** Regla 4: sin escritor vivo no existe ninguna cola, y nada procesa la entrada. */
const NO_WRITER: WriterView = {
  backlog_bytes: 0,
  backlog_count: 0,
  connection_state: 'disconnected',
  minimum_health: 'paused',
  rule: 4,
};

/**
 * La edad máxima, en milisegundos, del latido de un escritor que todavía informa (regla 5). Un
 * latido posterior a la observación, porque el reloj retrocedió, no la supera.
 */
const HEARTBEAT_MAX_AGE_MS = 45_000;

/** La hora del último `ConnectionOpened` o `ConnectionClosed` del log, o `null` si no tiene. */
function lastConnectionEventTime(segments: readonly (readonly SourceEvent[])[]): string | null {
  let time: string | null = null;
  for (const event of segments.flat()) {
    if (event.kind === 'connection_opened' || event.kind === 'connection_closed') {
      time = event.occurred_at_utc;
    }
  }
  return time;
}

/**
 * La regla del escritor que se aplica (ADR-0015 §8, reglas 4 a 6). El escritor vivo es el de este
 * esquema si su PID es el del último latido.
 */
function writerView(observation: ObservedSource): WriterView {
  const { latestHeartbeat: heartbeat, writerPid } = observation;
  if (writerPid === null) {
    return NO_WRITER;
  }
  // El último latido solo cuenta si es del escritor vivo: con otro PID, el escritor vivo no escribió
  // ninguno después, y su backlog es 0 (regla 6).
  const own = heartbeat?.pg_backend_pid === writerPid ? heartbeat : null;
  if (
    own !== null &&
    Date.parse(observation.now) - Date.parse(own.observed_at_utc) <= HEARTBEAT_MAX_AGE_MS
  ) {
    // Regla 5. Si el latido no es posterior al último evento de conexión del log, el log ya sabe más
    // que él, como entre una reconexión y su latido (ADR-0015 §11), y la conexión sale del log.
    const lastConnection = lastConnectionEventTime(observation.segments);
    const later =
      lastConnection === null || Date.parse(own.observed_at_utc) > Date.parse(lastConnection);
    return {
      backlog_bytes: own.backlog_bytes,
      backlog_count: own.backlog_count,
      ...(later ? { connection_state: own.connection_state } : {}),
      rule: 5,
    };
  }
  // Regla 6: el escritor vivo no es el de este esquema, como un proceso nuevo antes de su primer
  // latido, o su latido venció. La conexión sale del log, y la salud es como mínimo `paused`, porque
  // el proceso no avanza o todavía no informa.
  return {
    backlog_bytes: own?.backlog_bytes ?? 0,
    backlog_count: own?.backlog_count ?? 0,
    minimum_health: 'paused',
    rule: 6,
  };
}

/**
 * El log como lo dejará el próximo arranque (regla 4): si su última conexión no tiene cierre durable,
 * le añade al final, solo en memoria, el cierre que la sesión persistirá antes de abrir el socket
 * siguiente (`unrecordedClose`), con el símbolo pedido como afectado y la hora de la observación. El
 * log observado no cambia.
 */
function withUnrecordedClose(observation: ObservedSource): readonly (readonly SourceEvent[])[] {
  const { segments } = observation;
  const previous = previousConnection(segments);
  if (previous === null || previous.closed) {
    return segments;
  }
  const close = unrecordedClose({
    affected_symbols: [observation.symbol],
    connection_id: previous.connection_id,
    event_id: observation.nextId(),
    occurred_at_utc: observation.now,
    source: observation.source,
  });
  return [...segments.slice(0, -1), [...(segments.at(-1) ?? []), close]];
}

/** Las reglas 4 a 7 sobre lo observado, después de la regla 2. */
function evaluateObserved(observation: ObservedSource): HealthEvaluation {
  const writer = writerView(observation);
  // El cierre de la regla 4 es de una conexión sin cierre durable, así que no cambia lo que comprueba
  // la regla 2, y basta una derivación.
  const segments = writer.rule === 4 ? withUnrecordedClose(observation) : observation.segments;
  const checked = checkObservedLog(observation, segments);
  if (checked.status === 'failed') {
    return failedEvaluation(observation.source, checked.reason);
  }
  const report = deriveHealthReport({
    backlog_bytes: writer.backlog_bytes,
    backlog_count: writer.backlog_count,
    ...(writer.connection_state === undefined ? {} : { connection_state: writer.connection_state }),
    derived: checked.derived,
    last_published_dataset_id: observation.lastPublishedDatasetId,
    ...(writer.minimum_health === undefined ? {} : { minimum_health: writer.minimum_health }),
    operational_condition_types: observation.operationalConditionTypes,
    source: observation.source,
    sourceEvents: segments.flat(),
  });
  return { alert: null, exitCode: report.service_health === 'healthy' ? 0 : 1, report };
}

/**
 * La salud de datos de una fuente según lo observado (ADR-0015 §8, reglas 2 a 7): el `HealthReport`,
 * el código de salida y la alerta de stderr. Es pura: la hora y los IDs llegan con la observación.
 */
export function evaluateDataHealth(observation: HealthObservation): HealthEvaluation {
  switch (observation.status) {
    case 'storage_unavailable':
      // Regla 3: no se pudo observar nada.
      return {
        alert: { event: 'data_health_storage_unavailable', reason: observation.reason },
        exitCode: 1,
        report: unobservedHealthReport({ service_health: 'paused', source: observation.source }),
      };
    case 'incompatible':
      return failedEvaluation(observation.source, observation.reason);
    case 'observed':
      return evaluateObserved(observation);
  }
}
