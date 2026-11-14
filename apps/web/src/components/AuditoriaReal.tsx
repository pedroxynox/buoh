'use client';

import type { AuditActor, AuditEvent } from '@buoh/contracts';
import { Callout, Card, PhaseLock } from '@buoh/design-system/react';
import { formatUtc } from '@buoh/prototype-data';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { PageHeader } from './AppShell';
import { EventosDeDatosView, type DataEventsState } from './auditoria/EventosDeDatos';
import { api, ApiCallError, describeFailure } from './auth/api';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly unauthenticated: boolean }
  | { readonly kind: 'ready'; readonly events: readonly AuditEvent[] };

const ACTOR: Readonly<Record<AuditActor, string>> = {
  account: 'Propietario',
  operator: 'Consola (operador)',
  system: 'Sistema',
  anonymous: 'Sin sesión',
};

/** Una frase en español para cada acción y su motivo (ADR-0019 §5). */
function eventLabel(event: AuditEvent): string {
  switch (event.action) {
    case 'account_enrolled':
      return 'Cuenta dada de alta';
    case 'credential_disabled':
      return 'Credencial deshabilitada por demasiados fallos';
    case 'credential_reset':
      return 'Credencial restablecida';
    case 'link_created':
      return event.reason === 'reset'
        ? 'Enlace de restablecimiento creado'
        : 'Enlace de alta creado';
    case 'link_used':
      return event.reason === 'reset' ? 'Enlace de restablecimiento usado' : 'Enlace de alta usado';
    case 'login_failed':
      return 'Intento de inicio fallido';
    case 'login_failures': {
      const base =
        event.reason === 'unknown_username'
          ? 'Intentos con un usuario inexistente'
          : event.reason === 'disabled_credential'
            ? 'Intentos con una credencial deshabilitada'
            : 'Intentos rechazados por el límite';
      return `${base} (${String(event.failure_count)})`;
    }
    case 'session_started':
      return 'Sesión iniciada';
    case 'session_closed':
      return event.reason === 'session_limit'
        ? 'Sesión cerrada por el límite de 10'
        : 'Sesión cerrada';
    case 'sessions_closed':
      return event.reason === 'operator_command'
        ? 'Sesiones cerradas desde la consola'
        : event.reason === 'credential_reset'
          ? 'Sesiones cerradas por un restablecimiento'
          : 'Otras sesiones cerradas';
  }
}

/** Un fallo de la API como estado de error, con su texto fijo y si falta la sesión. */
function failureOf(caught: unknown, fallback: string) {
  return {
    kind: 'error',
    message: caught instanceof ApiCallError ? describeFailure(caught.failure) : fallback,
    unauthenticated: caught instanceof ApiCallError && caught.failure.code === 'unauthenticated',
  } as const;
}

/**
 * Auditoría de la web servida por la API (ADR-0019 §5 y §9): pide al abrir la página las entradas
 * reales de la cuenta y los eventos de datos de los logs, cada lista de la más nueva a la más vieja.
 * Las órdenes llegan en Fase 4, con su candado. Sin sesión, invita a iniciarla.
 */
export function AuditoriaReal() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [dataState, setDataState] = useState<DataEventsState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    api
      .audit()
      .then((events) => {
        if (active) setState({ kind: 'ready', events });
      })
      .catch((caught: unknown) => {
        if (active) setState(failureOf(caught, 'No se pudo cargar la auditoría.'));
      });
    api
      .dataEvents()
      .then((data) => {
        if (active) setDataState({ kind: 'ready', data });
      })
      .catch((caught: unknown) => {
        if (active) setDataState(failureOf(caught, 'No se pudieron cargar los eventos de datos.'));
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <PageHeader
        eyebrow="Auditoría"
        title="¿Qué pasó, cuándo y quién lo hizo?"
        summary="Registros que solo crecen: nada se edita. Los eventos de la cuenta y las publicaciones de los datasets se guardan siempre, y los demás de datos, 30 días con su log."
      />

      <Card title="Eventos de la cuenta" subtitle="Registro inmutable" headingLevel={2}>
        {state.kind === 'loading' ? (
          <p className="b-secondary">Cargando la auditoría…</p>
        ) : state.kind === 'error' ? (
          <Callout tone="rojo" icon="alertTriangle" title="No se pudo cargar">
            {state.message}
            {state.unauthenticated ? (
              <p>
                <Link className="w-link" href="/acceso">
                  Iniciar sesión
                </Link>
              </p>
            ) : null}
          </Callout>
        ) : state.events.length === 0 ? (
          <p className="b-secondary">Todavía no hay eventos.</p>
        ) : (
          <div className="w-table-wrap">
            <table className="b-table">
              <thead>
                <tr>
                  <th scope="col">Cuándo</th>
                  <th scope="col">Quién</th>
                  <th scope="col">Evento</th>
                  <th scope="col">Petición</th>
                </tr>
              </thead>
              <tbody>
                {state.events.map((event) => (
                  <tr key={event.audit_event_id}>
                    <td className="b-num w-small">{formatUtc(event.occurred_at_utc)}</td>
                    <td>{ACTOR[event.actor]}</td>
                    <td>{eventLabel(event)}</td>
                    <td className="b-num w-small">
                      {event.request_id === null ? '—' : event.request_id.slice(0, 8)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <EventosDeDatosView state={dataState} />

      <PhaseLock
        phase="4"
        title="Órdenes, respuestas y reconciliaciones"
        description="Cada intento se registrará antes de enviarse, con su clave de idempotencia y su resultado."
      />
    </>
  );
}
