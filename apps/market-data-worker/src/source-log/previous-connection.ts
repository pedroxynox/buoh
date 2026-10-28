import { type SourceEvent } from '@buoh/contracts';

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
 * log no tiene ningún `ConnectionOpened`.
 */
export function previousConnection(
  segments: readonly (readonly SourceEvent[])[],
): PreviousConnection | null {
  let connectionId: string | null = null;
  let closedAt: string | null = null;
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
