import type { DataEvents } from '@buoh/contracts';
import { Callout, Card, SeverityTag } from '@buoh/design-system/react';
import { formatUtc } from '@buoh/prototype-data';
import Link from 'next/link';
import { dataEventDetail, dataEventId, dataEventTitle, spanishList } from './eventos';
import { DATA_EVENTS_LIMIT } from './respuesta';

/** Lo que se sabe de los eventos de datos: leyendo, un fallo con su texto fijo, o la respuesta. */
export type DataEventsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly unauthenticated: boolean }
  | { readonly kind: 'ready'; readonly data: DataEvents };

/** Cuánto se guardan y de qué logs salen, para que se sepa qué falta (ADR-0019 §5). */
function retentionNote(data: DataEvents | null): string {
  const base =
    'Cada evento sigue en el log de su semana y se borra con él, a los 30 días de su última escritura. Las publicaciones de los datasets no vencen: siguen aunque su log ya no exista.';
  if (data === null || data.logs.length === 0) {
    return base;
  }
  const read =
    data.logs.length === 1
      ? ` Se leyó el log ${spanishList(data.logs)}.`
      : ` Se leyeron los logs ${spanishList(data.logs)}.`;
  const cut = data.truncated
    ? ` Se muestran los ${String(DATA_EVENTS_LIMIT)} más recientes: hay otros más viejos.`
    : '';
  return `${base}${read}${cut}`;
}

/**
 * Los eventos de datos en la Auditoría (concepto de interfaz §12): las versiones del catálogo, las
 * publicaciones, las incidencias y las condiciones que guardan los logs, del más nuevo al más viejo,
 * sin controles para cambiarlos. Recibe el estado y no pide nada.
 */
export function EventosDeDatosView({ state }: { readonly state: DataEventsState }) {
  return (
    <Card title="Eventos de datos" subtitle="De los logs de la captura" headingLevel={2}>
      {state.kind === 'loading' ? (
        <p className="b-secondary">Cargando los eventos de datos…</p>
      ) : state.kind === 'error' ? (
        <Callout tone="rojo" icon="alertTriangle" title="No se pudieron cargar">
          {state.message}
          {state.unauthenticated ? (
            <p>
              <Link className="w-link" href="/acceso">
                Iniciar sesión
              </Link>
            </p>
          ) : null}
        </Callout>
      ) : state.data.events.length === 0 ? (
        <p className="b-secondary">
          {state.data.logs.length === 0
            ? 'Todavía no hay ningún log de la captura.'
            : 'Los logs guardados no tienen eventos de datos.'}
        </p>
      ) : (
        <div className="w-table-wrap">
          <table className="b-table">
            <thead>
              <tr>
                <th scope="col">Cuándo</th>
                <th scope="col">Log</th>
                <th scope="col">Evento</th>
                <th scope="col">Detalle</th>
              </tr>
            </thead>
            <tbody>
              {state.data.events.map((event, index) => (
                <tr key={`${event.kind}:${dataEventId(event)}:${String(index)}`}>
                  <td className="b-num w-small">{formatUtc(event.at_utc)}</td>
                  <td className="b-num">{event.log}</td>
                  <td>
                    {dataEventTitle(event)}
                    {event.kind === 'incident' ? (
                      <>
                        {' '}
                        <SeverityTag severity={event.severity} />
                      </>
                    ) : null}
                  </td>
                  <td className="w-small">{dataEventDetail(event)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="b-secondary w-small">
        {retentionNote(state.kind === 'ready' ? state.data : null)}
      </p>
    </Card>
  );
}
