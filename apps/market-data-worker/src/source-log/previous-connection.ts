import { type SourceEvent } from '@buoh/contracts';

/** La conexión anterior del log (ADR-0015 §3, «Conexión anterior»). */
export interface PreviousConnection {
  /** Un `ConnectionClosed` durable con su `connection_id` sigue a su apertura. */
  readonly closed: boolean;
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
  let closed = false;
  for (const event of segments.flat()) {
    if (event.kind === 'connection_opened') {
      connectionId = event.connection_id;
      closed = false;
    } else if (event.kind === 'connection_closed' && event.connection_id === connectionId) {
      closed = true;
    }
  }
  return connectionId === null ? null : { closed, connection_id: connectionId };
}
