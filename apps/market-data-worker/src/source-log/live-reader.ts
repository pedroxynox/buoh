/**
 * Los lectores en vivo del log de una fuente desde su último punto de control válido (ADR-0017 §4):
 * en lugar de leer y derivar el log entero, parten de ese punto de control y leen solo lo
 * posterior, un segmento cerrado cada vez. La sesión de ingesta los usa en el arranque, en la
 * reparación de cierres y en la vigilancia de huecos.
 */
import { type LiveDerivationState, type SourceEvent } from '@buoh/contracts';
import { foldLiveDerivation, type LiveDerivationView } from '@buoh/domain';

import { type LiveCheckpointBase, type LiveCheckpointLookup } from './live-checkpoint.js';
import { previousConnection, type PreviousConnection } from './previous-connection.js';
import { LogNotDerivableError, type SourceEventLog } from './source-event-log.js';

/**
 * Recorre lo durable del log desde su último punto de control válido (ADR-0017 §4), sin tenerlo
 * entero en memoria:
 *
 * 1. al llamarla, antes de esperar nada, toma la foto del segmento abierto (`openSegment`);
 * 2. busca el último punto de control válido por debajo de ese segmento (`lastValid`): así un
 *    segmento que se cierre mientras lee no se aplica dos veces;
 * 3. empieza con `start` desde ese punto de control, o desde el log vacío, y aplica con `apply` los
 *    eventos de cada segmento cerrado posterior, leídos y verificados de uno en uno
 *    (`readClosedSegment`), y al final los del segmento abierto de la foto.
 *
 * Los objetos de los segmentos anteriores al punto de control no se leen (§4, «Integridad de los
 * objetos»). Lanza `LogReadError` si un almacén no responde y `LogIntegrityError` si el contenido
 * no pasa sus comprobaciones; lo que lancen `start` o `apply`, tal cual.
 */
export async function readSinceCheckpoint<T>(
  log: SourceEventLog,
  lookup: LiveCheckpointLookup,
  start: (base: LiveCheckpointBase) => T,
  apply: (accumulated: T, events: readonly SourceEvent[]) => T,
): Promise<T> {
  const open = log.openSegment();
  const base = await lookup.lastValid(log, open.segment_index);
  let accumulated = start(base);
  for (let index = base.segment_index + 1; index < open.segment_index; index += 1) {
    accumulated = apply(accumulated, (await log.readClosedSegment(index)).events);
  }
  return apply(accumulated, open.events);
}

/**
 * El estado vivo del log durable, desde su último punto de control válido (`readSinceCheckpoint`).
 * Si el pliegue falla, el log no se puede derivar: lanza `LogNotDerivableError`, con el error del
 * pliegue como causa.
 */
export function readLiveState(
  log: SourceEventLog,
  lookup: LiveCheckpointLookup,
): Promise<LiveDerivationState> {
  return readSinceCheckpoint(
    log,
    lookup,
    (base) => base.state,
    (state, events) => {
      try {
        return foldLiveDerivation(state, events, lookup.profile);
      } catch (error) {
        throw new LogNotDerivableError(error);
      }
    },
  );
}

/**
 * La conexión anterior del log durable (ADR-0015 §3), desde su último punto de control válido: la
 * del punto de control, seguida de la de los eventos posteriores (`previousConnection`). No pliega
 * esos eventos, así que, como la del log entero, no falla porque el log no se pueda derivar.
 */
export function readPreviousConnection(
  log: SourceEventLog,
  lookup: LiveCheckpointLookup,
): Promise<PreviousConnection | null> {
  return readSinceCheckpoint<PreviousConnection | null>(
    log,
    lookup,
    ({ state }) =>
      state.previous_connection === null
        ? null
        : {
            closed: state.previous_connection.closed_at_utc !== null,
            closed_at_utc: state.previous_connection.closed_at_utc,
            connection_id: state.previous_connection.connection_id,
          },
    (previous, events) => previousConnection([events], previous),
  );
}

/** El high-watermark del símbolo en la vista viva: la hora de su último tick, la mayor, o `null`. */
export function liveWatermark(view: LiveDerivationView, symbol: string): string | null {
  return view.watermarks.find((item) => item.symbol === symbol)?.event_time_utc ?? null;
}
