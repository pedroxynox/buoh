import { type IngestionCursor, type SourceEvent } from '@buoh/contracts';
import { deriveMarketData, type DerivedMarketData, type PipelineProfile } from '@buoh/domain';

import { failureReason, sourceEventId } from '../source-log/source-event-log.js';

/**
 * ¿El último cursor del símbolo apunta a un evento que no está en el log durable? (ADR-0015 §5 y §6,
 * `cursor_ahead_of_log`): el log perdió datos que el índice había confirmado. Lo comprueban el
 * arranque de la sesión y `data:health` (§8, regla 2), después de `checkLogContent`. Un cursor que va
 * por detrás del log, porque el proceso cayó después de escribirlo, no lo está; sin cursor, tampoco.
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

/**
 * ¿El log es de otro símbolo? (ADR-0015 §5, `symbol_mismatch`). Un log lo escribe una sesión de un
 * solo símbolo, así que sus cursores dan su símbolo, también si no tiene ticks: lo es si algún cursor
 * de la fuente es de otro símbolo o si la derivación tiene un tick de otro símbolo. El perfil admite
 * solo el símbolo pedido, así que ese tick queda como frame inválido con `symbol_not_allowed`.
 */
export function isOtherSymbol(input: {
  readonly cursorSymbols: readonly string[];
  readonly derived: DerivedMarketData;
  readonly symbol: string;
}): boolean {
  return (
    input.cursorSymbols.some((item) => item !== input.symbol) ||
    input.derived.incidents.some(
      (incident) =>
        incident.incident_type === 'invalid_source_frame' &&
        incident.evidence.reason === 'symbol_not_allowed',
    )
  );
}

/**
 * Las comprobaciones del contenido del log que comparten el arranque de la sesión (ADR-0015 §5) y
 * `data:health` (ADR-0015 §8, regla 2), en este orden:
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
  const foreign = segments.some((segment) =>
    segment.some(
      (event) =>
        event.kind === 'raw_source_frame' && event.connector_version !== profile.connector_version,
    ),
  );
  if (foreign) {
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
