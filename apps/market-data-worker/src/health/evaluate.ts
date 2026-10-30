import {
  type ConditionType,
  type HealthReport,
  type IngestionCursor,
  type LiveDerivationState,
  type ServiceHealth,
} from '@buoh/contracts';
import {
  deriveLiveHealthReport,
  emptyLiveDerivationState,
  foldLiveDerivation,
  liveDerivationView,
  unobservedHealthReport,
  type PipelineProfile,
} from '@buoh/domain';

import { checkFoldedContent, isOtherSymbolSeen, type CheckedFold } from '../deriv/log-check.js';
import { type IngestionHeartbeat } from '../ingestion/status.js';
import { unrecordedClose } from '../source-log/previous-connection.js';

/**
 * El log durable que observó `data:health`, leído desde su último punto de control válido (ADR-0017
 * §4). Sin el esquema de fuente guardado no hay perfil con el que plegarlo, y solo se sabe si tiene
 * eventos (`unprofiled`). Con él, su pliegue (`foldSinceCheckpoint`) y si el índice tiene el evento
 * del último cursor del símbolo (`cursor_in_log`: `null` sin cursor o si el contenido del log no
 * pasa sus comprobaciones, que van antes, como al arrancar).
 */
export type ObservedLog =
  | { readonly empty: boolean; readonly status: 'unprofiled' }
  | {
      readonly cursor_in_log: boolean | null;
      readonly fold: CheckedFold;
      readonly status: 'folded';
    };

/** Lo observado de una fuente que se pudo leer entera (ADR-0015 §8, «Entradas»). */
export interface ObservedSource {
  /** Los símbolos que tienen algún cursor de la fuente (`IngestionStatusStore.cursorSymbols`). */
  readonly cursorSymbols: readonly string[];
  /** El `dataset_id` del último dataset activo de la fuente en el entorno, o `null`. */
  readonly lastPublishedDatasetId: string | null;
  /**
   * El último cursor del símbolo pedido (`IngestionStatusStore.latestCursor`), o `null` si no tiene
   * ninguno.
   */
  readonly latestCursor: IngestionCursor | null;
  /** El último latido escrito de la fuente (`IngestionStatusStore.latestHeartbeat`), o `null`. */
  readonly latestHeartbeat: IngestionHeartbeat | null;
  /** UUIDv7 para el cierre que la regla 4 añade en memoria. */
  readonly nextId: () => string;
  /** La hora de la observación, UTC con milisegundos. */
  readonly now: string;
  /** El log durable, desde su último punto de control válido. */
  readonly log: ObservedLog;
  /** Los tipos abiertos del registro operativo. */
  readonly operationalConditionTypes: readonly ConditionType[];
  /**
   * El perfil de medición del símbolo, con el esquema de fuente que guardó la ingesta, o `null` si
   * no hay esquema guardado.
   */
  readonly profile: PipelineProfile | null;
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
 * falta o que no coincide con su SHA-256 fijado. Quien espera la observación con un plazo decide el
 * tercero: `checkpoint_rebuild_incomplete` si el plazo se cumplió mientras reconstruía el estado vivo
 * desde el último punto de control válido (ADR-0017 §6).
 */
export type HealthObservation =
  | { readonly reason: string; readonly source: string; readonly status: 'incompatible' }
  | { readonly reason: string; readonly source: string; readonly status: 'storage_unavailable' }
  | { readonly source: string; readonly status: 'checkpoint_rebuild_incomplete' }
  | ObservedSource;

/** La alerta de stderr de las reglas 2 y 3 y de una reconstrucción que no terminó, saneada. */
export interface HealthAlert {
  readonly event:
    | 'data_health_checkpoint_rebuild_incomplete'
    | 'data_health_failed'
    | 'data_health_storage_unavailable';
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

/** El estado vivo del log, o el motivo de la regla 2 que no pasa. */
type ObservedLogCheck =
  | { readonly state: LiveDerivationState; readonly status: 'passed' }
  | { readonly reason: string; readonly status: 'failed' };

/**
 * Las comprobaciones de la regla 2 sobre el log observado, las del arranque de la sesión y en su
 * orden (ADR-0015 §5): las del contenido sobre su pliegue (`checkFoldedContent`) y después el último
 * cursor del símbolo contra el índice, sin el cierre que la regla 4 añade en memoria
 * (`cursor_ahead_of_log`), como pide §6. Sin el esquema de fuente guardado, un log no vacío no se
 * puede derivar (`source_schema_missing`), y uno vacío solo se comprueba con los cursores de la
 * fuente: un cursor nunca apunta a un evento de un log sin eventos.
 */
function checkObservedLog(observation: ObservedSource): ObservedLogCheck {
  const { cursorSymbols, latestCursor, log, symbol } = observation;
  if (log.status === 'unprofiled') {
    if (!log.empty) {
      return { reason: 'source_schema_missing', status: 'failed' };
    }
    if (isOtherSymbolSeen({ cursorSymbols, symbol, symbolNotAllowedSeen: false })) {
      return { reason: 'symbol_mismatch', status: 'failed' };
    }
    return latestCursor === null
      ? { state: emptyLiveDerivationState(), status: 'passed' }
      : { reason: 'cursor_ahead_of_log', status: 'failed' };
  }
  const content = checkFoldedContent(log.fold, { cursorSymbols, symbol });
  if (content.status === 'failed') {
    return { reason: content.reason, status: 'failed' };
  }
  if (log.cursor_in_log === false) {
    return { reason: 'cursor_ahead_of_log', status: 'failed' };
  }
  return { state: content.state, status: 'passed' };
}

/**
 * Lo que da la regla del escritor que se aplica (ADR-0015 §8, reglas 4 a 6): el backlog, la conexión
 * si no sale del log y la salud mínima.
 */
export interface WriterView {
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

/**
 * La regla del escritor que se aplica (ADR-0015 §8, reglas 4 a 6). El escritor vivo es el de este
 * esquema si su PID es el del último latido. `lastConnectionEventTimeUtc` es la hora del último
 * `ConnectionOpened` o `ConnectionClosed` del log, o `null` si no tiene.
 */
export function writerView(
  observation: Pick<ObservedSource, 'latestHeartbeat' | 'now' | 'writerPid'>,
  lastConnectionEventTimeUtc: string | null,
): WriterView {
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
    const later =
      lastConnectionEventTimeUtc === null ||
      Date.parse(own.observed_at_utc) > Date.parse(lastConnectionEventTimeUtc);
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
 * El estado vivo como lo dejará el próximo arranque (regla 4): si la última conexión del log no tiene
 * cierre durable, le aplica al final, solo en memoria, el cierre que la sesión persistirá antes de
 * abrir el socket siguiente (`unrecordedClose`), con el símbolo pedido como afectado y la hora de la
 * observación (ADR-0017 §4). El log observado no cambia. Un log sin perfil no tiene eventos, así que
 * tampoco una conexión que cerrar. Si el pliegue no acepta el cierre, el log no se deriva con él:
 * `null`.
 */
function withUnrecordedClose(
  state: LiveDerivationState,
  observation: ObservedSource,
): LiveDerivationState | null {
  const previous = state.previous_connection;
  if (previous?.closed_at_utc !== null || observation.profile === null) {
    return state;
  }
  const close = unrecordedClose({
    affected_symbols: [observation.symbol],
    connection_id: previous.connection_id,
    event_id: observation.nextId(),
    occurred_at_utc: observation.now,
    source: observation.source,
  });
  try {
    return foldLiveDerivation(state, [close], observation.profile);
  } catch {
    return null;
  }
}

/** Las reglas 4 a 7 sobre lo observado, después de la regla 2. */
function evaluateObserved(observation: ObservedSource): HealthEvaluation {
  // El cierre de la regla 4 es de una conexión sin cierre durable, así que no cambia lo que comprueba
  // la regla 2: se comprueba el log observado.
  const checked = checkObservedLog(observation);
  if (checked.status === 'failed') {
    return failedEvaluation(observation.source, checked.reason);
  }
  const writer = writerView(observation, checked.state.last_connection_event_time_utc);
  const state = writer.rule === 4 ? withUnrecordedClose(checked.state, observation) : checked.state;
  if (state === null) {
    // Como cuando `deriveMarketData` no derivaba el log con ese cierre.
    return failedEvaluation(observation.source, 'log_not_derivable');
  }
  const report = deriveLiveHealthReport({
    backlog_bytes: writer.backlog_bytes,
    backlog_count: writer.backlog_count,
    ...(writer.connection_state === undefined ? {} : { connection_state: writer.connection_state }),
    last_published_dataset_id: observation.lastPublishedDatasetId,
    ...(writer.minimum_health === undefined ? {} : { minimum_health: writer.minimum_health }),
    operational_condition_types: observation.operationalConditionTypes,
    source: observation.source,
    view: liveDerivationView(state),
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
    case 'checkpoint_rebuild_incomplete':
      // ADR-0017 §6: sin un punto de control válido, como mientras `ingest` todavía no escribió los
      // de una versión nueva, la reconstrucción en memoria no terminó en el plazo.
      return {
        alert: { event: 'data_health_checkpoint_rebuild_incomplete', reason: 'deadline_exceeded' },
        exitCode: 1,
        report: unobservedHealthReport({ service_health: 'paused', source: observation.source }),
      };
    case 'observed':
      return evaluateObserved(observation);
  }
}
