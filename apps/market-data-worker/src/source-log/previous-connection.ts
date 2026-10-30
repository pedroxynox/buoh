import { connectionClosedSchema, type ConnectionClosed, type SourceEvent } from '@buoh/contracts';
import { CONTRACT_SCHEMA_VERSION } from '@buoh/domain';

/** La conexión anterior del log (ADR-0015 §3, «Conexión anterior»). */
export interface PreviousConnection {
  /** Un `ConnectionClosed` durable con su `connection_id` sigue a su apertura. */
  readonly closed: boolean;
  /**
   * Hora (`occurred_at_utc`) de ese `ConnectionClosed`, o `null` si no lo tiene. El
   * `ConnectionOpened` que supera la conexión tiene que ser posterior.
   */
  readonly closed_at_utc: string | null;
  readonly connection_id: string;
}

/**
 * Conexión anterior según el log durable: la última con `ConnectionOpened` en el log, y si la sigue
 * su `ConnectionClosed`. Nunca sale de la memoria de una sesión: un intento cuyo `ConnectionOpened`
 * no quedó durable no existe para el log, así que no se supera ni se repara. Es `null` solo si el
 * log no tiene ningún `ConnectionOpened`. Con `initial`, `segments` son los posteriores a un punto de
 * control, y `initial` la conexión anterior hasta él (ADR-0017 §4).
 */
export function previousConnection(
  segments: readonly (readonly SourceEvent[])[],
  initial: PreviousConnection | null = null,
): PreviousConnection | null {
  let connectionId: string | null = initial?.connection_id ?? null;
  let closedAt: string | null = initial?.closed_at_utc ?? null;
  for (const event of segments.flat()) {
    if (event.kind === 'connection_opened') {
      connectionId = event.connection_id;
      closedAt = null;
    } else if (event.kind === 'connection_closed' && event.connection_id === connectionId) {
      closedAt = event.occurred_at_utc;
    }
  }
  return connectionId === null
    ? null
    : { closed: closedAt !== null, closed_at_utc: closedAt, connection_id: connectionId };
}

/**
 * El `ConnectionClosed` que repara una conexión anterior sin cierre durable (ADR-0015 §3, «Cierre no
 * registrado»): `transport_error`, motivo `close_not_recorded`, los símbolos de la sesión como
 * afectados, ordenados y sin repetir, y la hora de la detección. Lo persiste
 * `RawFirstIngestor.repairUnrecordedClose`; `data:health` deriva con él sin persistirlo (ADR-0015
 * §8, regla 4).
 */
export function unrecordedClose(input: {
  readonly affected_symbols: readonly string[];
  readonly connection_id: string;
  readonly event_id: string;
  readonly occurred_at_utc: string;
  readonly source: string;
}): ConnectionClosed {
  return connectionClosedSchema.parse({
    affected_symbols: [...new Set(input.affected_symbols)].sort(),
    closure_type: 'transport_error',
    connection_id: input.connection_id,
    event_id: input.event_id,
    kind: 'connection_closed',
    occurred_at_utc: input.occurred_at_utc,
    reason: 'close_not_recorded',
    schema_version: CONTRACT_SCHEMA_VERSION,
    source: input.source,
  });
}
