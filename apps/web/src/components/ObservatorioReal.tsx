'use client';

import { Badge, Callout, Card, HealthBadge, ModeBadge, PhaseLock } from '@buoh/design-system/react';
import { formatUtc, formatUtcTime } from '@buoh/prototype-data';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from './AppShell';
import { API_EXECUTION_MODE } from './modo';
import { DataMeta, SectionTitle } from './Pieces';
import {
  ageText,
  connectionLabel,
  HEALTH_SYMBOL,
  healthView,
  sourceLabel,
  type HealthView,
} from './salud/salud';
import { useDataHealth } from './salud/store';

/** La fuente de la captura que observa la salud (`DERIV_SOURCE` del worker), si no hay informe. */
const CAPTURE_SOURCE = 'deriv_options';

function conditionsText(count: number): string {
  if (count === 0) return 'Sin condiciones abiertas';
  return count === 1 ? '1 condición abierta' : `${String(count)} condiciones abiertas`;
}

function utcOrNone(value: string | null): string {
  return value === null ? 'Ninguno todavía' : formatUtc(value);
}

/** La insignia de la salud con su descripción, o la neutra cuando la web no la sabe. */
function HealthState({ view }: { readonly view: HealthView }) {
  return view.badge.kind === 'state' ? (
    <HealthBadge health={view.badge.health} showDescription />
  ) : (
    <Badge icon={view.badge.icon} title={`Salud: ${view.badge.label}. ${view.summary}`}>
      <span className="b-visually-hidden">Salud: </span>
      {view.badge.label}
    </Badge>
  );
}

function healthLine(view: HealthView): string {
  if (view.loading) return 'Leyendo la salud de los datos…';
  if (view.error !== null) return view.error;
  if (view.causes.length === 0) return 'Sin causas abiertas.';
  return `Causa: ${view.causes.map((cause) => cause.title).join(' · ')}.`;
}

/** Los metadatos de toda vista de datos (concepto de interfaz §1), más los del informe. */
function captureMeta(view: HealthView): (readonly [string, ReactNode])[] {
  const { observation, report } = view;
  const items: (readonly [string, ReactNode])[] = [
    [
      'Símbolo',
      <span key="s" className="b-num">
        {HEALTH_SYMBOL}
      </span>,
    ],
    ['Fuente', sourceLabel(report?.source ?? CAPTURE_SOURCE)],
    ['Zona horaria', 'UTC'],
    ['Intervalo', 'Una observación cada 5 minutos'],
    [
      'Frescura',
      observation === null ? (
        'Sin observación'
      ) : (
        <span key="f">
          {`${formatUtc(observation.observedAtUtc)}, hace ${ageText(observation.ageMs)}`}
          {observation.stale ? (
            <>
              {' '}
              <Badge icon="clock">Antigua</Badge>
            </>
          ) : null}
        </span>
      ),
    ],
    [
      'Calidad',
      report === null ? 'Sin informe' : conditionsText(report.open_condition_types.length),
    ],
    ['Log activo', view.log === null ? 'Ninguno' : `Log ${String(view.log)}`],
  ];
  if (report !== null) {
    items.push(
      ['Conexión', connectionLabel(report.connection_state)],
      ['Último mensaje recibido', utcOrNone(report.last_received_at_utc)],
      ['Último tick', utcOrNone(report.last_event_time_utc)],
      [
        'Cola sin guardar',
        `${String(report.backlog_count)} eventos · ${String(report.backlog_bytes)} bytes`,
      ],
    );
  }
  return items;
}

function CaptureDetail({ view }: { readonly view: HealthView }) {
  if (view.loading) {
    return (
      <>
        <div className="w-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p className="b-visually-hidden">Cargando la salud de los datos</p>
      </>
    );
  }
  if (view.error !== null) {
    return (
      <Callout tone="rojo" icon="alertTriangle" title="No se pudo leer la salud">
        {view.error}
        {view.unauthenticated ? (
          <p>
            <Link className="w-link" href="/acceso">
              Iniciar sesión
            </Link>
          </p>
        ) : null}
      </Callout>
    );
  }
  return (
    <div className="w-stack">
      <DataMeta items={captureMeta(view)} />
      <p className="b-eyebrow">Causa</p>
      {view.causes.length === 0 ? (
        <p className="b-secondary w-small">
          Sin causas abiertas: datos y persistencia verificados.
        </p>
      ) : (
        <ul className="w-list">
          {view.causes.map((cause, index) => (
            <li key={`${String(index)}-${cause.title}`}>
              <div>
                <strong className="w-small">{cause.title}</strong>
                <p className="b-muted w-small">{cause.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function datasetPart(view: HealthView): ReactNode {
  if (view.report === null) {
    return <p className="b-secondary w-small">Sin informe: la última observación no lo dice.</p>;
  }
  const id = view.report.last_published_dataset_id;
  return id === null ? (
    <p className="b-secondary w-small">
      Todavía no hay ninguno publicado: la captura de producción se publica como datasets más
      adelante en la Fase 2 (F2.5).
    </p>
  ) : (
    <span className="b-num w-small">{id}</span>
  );
}

/**
 * El Observatorio de la web servida por la API para una vista de la salud (concepto de interfaz §3 y
 * §10): la salud de la captura con su causa, el modo aparte, las condiciones abiertas y el último
 * dataset. Lo que todavía no existe, las estrategias y las señales, muestra su estado vacío, sin datos
 * ficticios (`F2-UI-001`).
 */
export function ObservatorioView({ view }: { readonly view: HealthView }) {
  return (
    <>
      <PageHeader
        eyebrow="Observatorio"
        title="¿Está todo bien ahora?"
        summary="La salud de la captura de producción, con su causa, y el modo de ejecución, cada uno por su lado. Se actualiza sola cada minuto."
      />

      {view.refreshError === null ? null : (
        <Callout tone="naranja" icon="alertTriangle" title="No se pudo actualizar">
          {view.refreshError}{' '}
          {view.receivedAtUtc === null
            ? null
            : `Lo que ves es de la lectura de las ${formatUtcTime(view.receivedAtUtc)}.`}
        </Callout>
      )}

      <div className="w-grid w-grid--4">
        <Card title="Modo de ejecución" subtitle="Qué puede hacer el bot" headingLevel={2}>
          <div className="w-stack">
            <ModeBadge mode={API_EXECUTION_MODE} showDescription />
            <p className="b-secondary w-small">
              Todavía no hay estrategias ni motor de señales. Nada sale al bróker.
            </p>
          </div>
        </Card>
        <Card title="Salud de los datos" subtitle="Captura de Deriv en producción" headingLevel={2}>
          <div className="w-stack">
            <HealthState view={view} />
            <p className="b-secondary w-small">{healthLine(view)}</p>
          </div>
        </Card>
        <Card title="Condiciones abiertas" subtitle="Calidad de los datos" headingLevel={2}>
          <div className="w-stack">
            <span className="w-stat__value b-num">
              {view.report === null ? '—' : String(view.report.open_condition_types.length)}
            </span>
            <p className="b-secondary w-small">
              {view.report === null
                ? 'Sin informe que las cuente.'
                : 'Su causa está en «Captura de Deriv».'}
            </p>
          </div>
        </Card>
        <Card title="Último dataset" subtitle="Reproducible por su identificador" headingLevel={2}>
          <div className="w-stack">{datasetPart(view)}</div>
        </Card>
      </div>

      <Card
        title="Captura de Deriv"
        subtitle="Última observación de buoh-operaciones"
        headingLevel={2}
      >
        <CaptureDetail view={view} />
      </Card>

      <SectionTitle>Bot shadow</SectionTitle>
      <div className="w-grid w-grid--wide">
        <Card title="Estrategias en shadow" subtitle="Siempre con su contexto completo">
          <p className="b-secondary w-small">
            Todavía no hay ninguna estrategia en shadow. Las estrategias, sus pruebas y el motor que
            las sigue en vivo llegan más adelante en la Fase 2.
          </p>
        </Card>
        <Card title="Detener todo" subtitle="Kill switch global">
          <PhaseLock
            phase="4"
            title="Kill switch"
            description="Detendrá a la vez todas las estrategias, cuentas y órdenes. En modo shadow no hay órdenes que detener."
          />
        </Card>
      </div>

      <SectionTitle>Últimas señales</SectionTitle>
      <Card>
        <p className="b-secondary w-small">
          Todavía no hay señales: ninguna estrategia está en shadow.
        </p>
      </Card>
    </>
  );
}

/** El Observatorio con la salud real: la misma lectura que la insignia de la barra superior. */
export function ObservatorioReal() {
  return <ObservatorioView view={healthView(useDataHealth())} />;
}
