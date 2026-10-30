import { type IngestionCursor, type LiveDerivationState, type SourceEvent } from '@buoh/contracts';
import {
  deriveMarketData,
  foldLiveDerivation,
  liveDerivationView,
  type DerivedMarketData,
  type PipelineProfile,
} from '@buoh/domain';

import { type LiveCheckpointLookup } from '../source-log/live-checkpoint.js';
import { liveWatermark, readSinceCheckpoint } from '../source-log/live-reader.js';
import {
  failureReason,
  sourceEventId,
  type SourceEventLog,
} from '../source-log/source-event-log.js';

/**
 * ¿El último cursor del símbolo apunta a un evento que no está en el log durable? (ADR-0015 §5 y §6,
 * `cursor_ahead_of_log`): el log perdió datos que el índice había confirmado. Lo comprueba
 * `data:health` (§8, regla 2), después de `checkLogContent`, recorriendo el log; el arranque de la
 * sesión lo busca en el índice (`checkLogSinceCheckpoint`). Un cursor que va por detrás del log,
 * porque el proceso cayó después de escribirlo, no lo está; sin cursor, tampoco.
 */
export function isCursorAheadOfLog(input: {
  readonly cursor: Pick<IngestionCursor, 'last_durable_source_event_id'> | null;
  readonly segments: readonly (readonly SourceEvent[])[];
}): boolean {
  const { cursor } = input;
  return (
    cursor !== null &&
    !input.segments.some((segment) =>
      segment.some((event) => sourceEventId(event) === cursor.last_durable_source_event_id),
    )
  );
}

/** Lo que da `checkLogContent`: la derivación del log, o por qué no pasa sus comprobaciones. */
export type LogContentCheck =
  | { readonly derived: DerivedMarketData; readonly status: 'passed' }
  | {
      /** Con `log_not_derivable`, el error de la derivación saneado (`failureReason`); si no, `null`. */
      readonly detail: string | null;
      readonly reason: 'connector_version_mismatch' | 'log_not_derivable' | 'symbol_mismatch';
      readonly status: 'failed';
    };

/** ¿Algún frame de estos eventos es de otro conector que el del perfil? (`connector_version_mismatch`) */
export function hasOtherConnector(
  events: readonly SourceEvent[],
  profile: PipelineProfile,
): boolean {
  return events.some(
    (event) =>
      event.kind === 'raw_source_frame' && event.connector_version !== profile.connector_version,
  );
}

/**
 * ¿El log es de otro símbolo? (ADR-0015 §5, `symbol_mismatch`). Un log lo escribe una sesión de un
 * solo símbolo, así que sus cursores dan su símbolo, también si no tiene ticks: lo es si algún cursor
 * de la fuente es de otro símbolo o si el log tiene un tick de otro símbolo. El perfil admite solo el
 * símbolo pedido, así que ese tick queda como frame inválido con `symbol_not_allowed`
 * (`symbolNotAllowedSeen`).
 */
export function isOtherSymbolSeen(input: {
  readonly cursorSymbols: readonly string[];
  readonly symbol: string;
  readonly symbolNotAllowedSeen: boolean;
}): boolean {
  return input.cursorSymbols.some((item) => item !== input.symbol) || input.symbolNotAllowedSeen;
}

/** `isOtherSymbolSeen` con la derivación del log entero: con sus incidencias `symbol_not_allowed`. */
export function isOtherSymbol(input: {
  readonly cursorSymbols: readonly string[];
  readonly derived: DerivedMarketData;
  readonly symbol: string;
}): boolean {
  return isOtherSymbolSeen({
    cursorSymbols: input.cursorSymbols,
    symbol: input.symbol,
    symbolNotAllowedSeen: input.derived.incidents.some(
      (incident) =>
        incident.incident_type === 'invalid_source_frame' &&
        incident.evidence.reason === 'symbol_not_allowed',
    ),
  });
}

/**
 * Las comprobaciones del contenido del log entero que hace `data:health` (ADR-0015 §8, regla 2), en
 * este orden, el mismo que el del arranque de la sesión (`checkLogSinceCheckpoint`):
 *
 * 1. todos sus frames son del conector del perfil (`connector_version_mismatch`);
 * 2. se deriva con el perfil (`log_not_derivable`);
 * 3. es del símbolo pedido (`symbol_mismatch`, `isOtherSymbol`), con los símbolos que tienen algún
 *    cursor de la fuente.
 *
 * Si las pasa, devuelve la derivación.
 */
export function checkLogContent(input: {
  readonly cursorSymbols: readonly string[];
  readonly profile: PipelineProfile;
  readonly segments: readonly (readonly SourceEvent[])[];
  readonly symbol: string;
}): LogContentCheck {
  const { profile, segments } = input;
  if (segments.some((segment) => hasOtherConnector(segment, profile))) {
    return { detail: null, reason: 'connector_version_mismatch', status: 'failed' };
  }
  let derived: DerivedMarketData;
  try {
    derived = deriveMarketData(segments, profile);
  } catch (error) {
    return { detail: failureReason(error), reason: 'log_not_derivable', status: 'failed' };
  }
  if (isOtherSymbol({ cursorSymbols: input.cursorSymbols, derived, symbol: input.symbol })) {
    return { detail: null, reason: 'symbol_mismatch', status: 'failed' };
  }
  return { derived, status: 'passed' };
}

/** Lo que el arranque lee del almacén del cursor (ADR-0015 §5). */
export interface StoredCursors {
  /** El último cursor del símbolo pedido, o `null` si no tiene ninguno. */
  readonly latest: IngestionCursor | null;
  /** Los símbolos que tienen algún cursor de la fuente. */
  readonly symbols: readonly string[];
}

/** Lo que la sesión toma del log al arrancar, cuando pasa sus comprobaciones. */
export interface StartupLog {
  /** La conexión del último evento del log, o `null` si está vacío. */
  readonly connection_id: string | null;
  /** El high-watermark del símbolo: la hora de su último tick, la mayor, o `null` sin ticks. */
  readonly high_watermark_utc: string | null;
  /** La hora del evento durable más antiguo, el primero del log, o `null` si está vacío. */
  readonly oldest_utc: string | null;
}

/** Lo que da `checkLogSinceCheckpoint`: lo que la sesión toma del log, o por qué no lo acepta. */
export type StartupCheck =
  | { readonly startup: StartupLog; readonly status: 'passed' }
  | {
      /** Con `log_not_derivable`, el error del pliegue saneado (`failureReason`); si no, `null`. */
      readonly detail: string | null;
      readonly reason:
        | 'connector_version_mismatch'
        | 'cursor_ahead_of_log'
        | 'log_not_derivable'
        | 'retention_expired'
        | 'symbol_mismatch';
      readonly status: 'failed';
    };

/** El pliegue del arranque: el estado vivo, el error que lo paró o un frame de otro conector. */
type StartupFold =
  | { readonly state: LiveDerivationState; readonly status: 'derived' }
  | { readonly error: unknown; readonly status: 'not_derivable' }
  | { readonly status: 'foreign' };

const failedWith = (
  reason: Extract<StartupCheck, { status: 'failed' }>['reason'],
  detail: string | null = null,
): StartupCheck => ({ detail, reason, status: 'failed' });

/**
 * Las comprobaciones del log antes de conectar (ADR-0015 §5), desde su último punto de control
 * válido (ADR-0017 §4), en este orden:
 *
 * 1. los frames posteriores al punto de control son del conector del perfil
 *    (`connector_version_mismatch`). Los anteriores ya lo eran: un punto de control lleva su conector
 *    entre sus versiones, así que uno de otro conector nunca es el último válido;
 * 2. esos eventos se pliegan desde él con el perfil de medición (`log_not_derivable`);
 * 3. es del símbolo pedido (`symbol_mismatch`, `isOtherSymbolSeen`), con los símbolos de los
 *    cursores de la fuente;
 * 4. el último cursor del símbolo apunta a un evento del log: lo busca en el índice
 *    (`SourceEventLog.hasEvent`), sin recorrer el log (`cursor_ahead_of_log`); si no está, el log
 *    perdió datos confirmados;
 * 5. con `retentionMs`, el evento durable más antiguo, el primero del índice (`firstEventTimeUtc`),
 *    no la cumplió todavía (`retention_expired`, ADR-0015 §7). Su hora es la de `sourceEventTime`:
 *    la recepción de un frame y `occurred_at_utc` de los demás.
 *
 * Lee todos los segmentos posteriores al punto de control, también después de uno que no se pliega,
 * así que un frame de otro conector en cualquiera de ellos da su motivo, como con el log entero. Sin
 * `cursors`, no hay comprobación con el cursor. Lanza `LogReadError` si un almacén no responde y
 * `LogIntegrityError` si el contenido no pasa sus comprobaciones (`readSinceCheckpoint`).
 */
export async function checkLogSinceCheckpoint(
  log: SourceEventLog,
  lookup: LiveCheckpointLookup,
  input: {
    readonly cursors: StoredCursors | null;
    readonly now: string;
    readonly retentionMs: number | undefined;
  },
): Promise<StartupCheck> {
  const { profile, symbol } = lookup;
  const folded = await readSinceCheckpoint<StartupFold>(
    log,
    lookup,
    (base) => ({ state: base.state, status: 'derived' }),
    (current, events) => {
      if (current.status === 'foreign' || hasOtherConnector(events, profile)) {
        return { status: 'foreign' };
      }
      if (current.status === 'not_derivable') {
        return current;
      }
      try {
        return { state: foldLiveDerivation(current.state, events, profile), status: 'derived' };
      } catch (error) {
        return { error, status: 'not_derivable' };
      }
    },
  );
  if (folded.status === 'foreign') {
    return failedWith('connector_version_mismatch');
  }
  if (folded.status === 'not_derivable') {
    return failedWith('log_not_derivable', failureReason(folded.error));
  }
  const view = liveDerivationView(folded.state);
  const { cursors } = input;
  if (
    isOtherSymbolSeen({
      cursorSymbols: cursors?.symbols ?? [],
      symbol,
      symbolNotAllowedSeen: view.symbolNotAllowedSeen,
    })
  ) {
    return failedWith('symbol_mismatch');
  }
  const cursor = cursors?.latest ?? null;
  if (cursor !== null && !(await log.hasEvent(cursor.last_durable_source_event_id))) {
    return failedWith('cursor_ahead_of_log');
  }
  const oldestUtc = log.firstEventTimeUtc;
  if (
    input.retentionMs !== undefined &&
    oldestUtc !== null &&
    Date.parse(input.now) >= Date.parse(oldestUtc) + input.retentionMs
  ) {
    return failedWith('retention_expired');
  }
  return {
    startup: {
      connection_id: view.lastEventConnectionId,
      high_watermark_utc: liveWatermark(view, symbol),
      oldest_utc: oldestUtc,
    },
    status: 'passed',
  };
}
