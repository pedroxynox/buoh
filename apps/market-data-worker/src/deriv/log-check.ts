import { type IngestionCursor, type LiveDerivationState, type SourceEvent } from '@buoh/contracts';
import { foldLiveDerivation, liveDerivationView, type PipelineProfile } from '@buoh/domain';

import { type LiveCheckpointLookup } from '../source-log/live-checkpoint.js';
import { liveWatermark, readSinceCheckpoint } from '../source-log/live-reader.js';
import { failureReason, type SourceEventLog } from '../source-log/source-event-log.js';

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

/**
 * Lo que da `checkLogSinceCheckpoint`: lo que la sesión toma del log, con su estado vivo, o por qué
 * no lo acepta.
 */
export type StartupCheck =
  | {
      readonly startup: StartupLog;
      readonly state: LiveDerivationState;
      readonly status: 'passed';
    }
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

/**
 * El pliegue de un lector que comprueba el log (ADR-0015 §5 y §8, regla 2): el estado vivo, el error
 * que lo paró o un frame de otro conector.
 */
export type CheckedFold =
  | { readonly state: LiveDerivationState; readonly status: 'derived' }
  | { readonly error: unknown; readonly status: 'not_derivable' }
  | { readonly status: 'foreign' };

/**
 * Aplica al pliegue los eventos de un segmento. Un frame de otro conector gana a un pliegue que ya
 * falló, como cuando la comprobación del conector recorría el log entero antes de derivarlo.
 */
export function foldCheckedSegment(
  current: CheckedFold,
  events: readonly SourceEvent[],
  profile: PipelineProfile,
): CheckedFold {
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
}

/**
 * El pliegue del log durable desde su último punto de control válido (`readSinceCheckpoint`), con
 * `foldCheckedSegment`. Lee todos los segmentos posteriores al punto de control, también después de
 * uno que no se pliega. Lanza `LogReadError` si un almacén no responde y `LogIntegrityError` si el
 * contenido no pasa sus comprobaciones.
 */
export function foldSinceCheckpoint(
  log: SourceEventLog,
  lookup: LiveCheckpointLookup,
): Promise<CheckedFold> {
  return readSinceCheckpoint<CheckedFold>(
    log,
    lookup,
    (base) => ({ state: base.state, status: 'derived' }),
    (current, events) => foldCheckedSegment(current, events, lookup.profile),
  );
}

/** Lo que da `checkFoldedContent`: el estado vivo, o por qué el contenido no pasa. */
export type FoldedContentCheck =
  | { readonly state: LiveDerivationState; readonly status: 'passed' }
  | {
      /** Con `log_not_derivable`, el error del pliegue saneado (`failureReason`); si no, `null`. */
      readonly detail: string | null;
      readonly reason: 'connector_version_mismatch' | 'log_not_derivable' | 'symbol_mismatch';
      readonly status: 'failed';
    };

/**
 * Las comprobaciones del contenido del log sobre su pliegue, en el orden de siempre: el conector, que
 * se derive y el símbolo, con los símbolos de los cursores de la fuente (`isOtherSymbolSeen`). Las
 * comparten el arranque de la sesión y `data:health`.
 */
export function checkFoldedContent(
  fold: CheckedFold,
  input: { readonly cursorSymbols: readonly string[]; readonly symbol: string },
): FoldedContentCheck {
  if (fold.status === 'foreign') {
    return { detail: null, reason: 'connector_version_mismatch', status: 'failed' };
  }
  if (fold.status === 'not_derivable') {
    return { detail: failureReason(fold.error), reason: 'log_not_derivable', status: 'failed' };
  }
  if (
    isOtherSymbolSeen({
      cursorSymbols: input.cursorSymbols,
      symbol: input.symbol,
      symbolNotAllowedSeen: fold.state.symbol_not_allowed_seen,
    })
  ) {
    return { detail: null, reason: 'symbol_mismatch', status: 'failed' };
  }
  return { state: fold.state, status: 'passed' };
}

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
 *    la recepción de un frame y `occurred_at_utc` de los demás. La hora actual (`now`) se lee al
 *    comprobarla, después de leer el log: una lectura larga, como la de todo el log sin un punto de
 *    control válido, no deja arrancar un log que la cumplió mientras se leía.
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
    readonly now: () => string;
    readonly retentionMs: number | undefined;
  },
): Promise<StartupCheck> {
  const { symbol } = lookup;
  const { cursors } = input;
  const content = checkFoldedContent(await foldSinceCheckpoint(log, lookup), {
    cursorSymbols: cursors?.symbols ?? [],
    symbol,
  });
  if (content.status === 'failed') {
    return content;
  }
  const view = liveDerivationView(content.state);
  const cursor = cursors?.latest ?? null;
  if (cursor !== null && !(await log.hasEvent(cursor.last_durable_source_event_id))) {
    return failedWith('cursor_ahead_of_log');
  }
  const oldestUtc = log.firstEventTimeUtc;
  if (
    input.retentionMs !== undefined &&
    oldestUtc !== null &&
    Date.parse(input.now()) >= Date.parse(oldestUtc) + input.retentionMs
  ) {
    return failedWith('retention_expired');
  }
  return {
    startup: {
      connection_id: view.lastEventConnectionId,
      high_watermark_utc: liveWatermark(view, symbol),
      oldest_utc: oldestUtc,
    },
    state: content.state,
    status: 'passed',
  };
}
