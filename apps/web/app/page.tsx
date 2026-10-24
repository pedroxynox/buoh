import {
  Badge,
  Card,
  HealthBadge,
  MetricWithContext,
  ModeBadge,
  PhaseLock,
  SeverityTag,
} from '@buoh/design-system/react';
import Link from 'next/link';
import { PageHeader } from '../src/components/AppShell';
import { SectionTitle, SignalCard } from '../src/components/Pieces';
import {
  DATASETS,
  DEMO_NOW_UTC,
  GLOBAL_STATUS,
  INCIDENT_LABELS,
  INCIDENTS,
  SHADOW_CONTEXT,
  SIGNALS,
  SOURCES,
} from '../src/fixtures';
import { formatUtc, formatUtcTime } from '../src/format';

export default function ObservatorioPage() {
  const openIncidents = INCIDENTS.filter((incident) => incident.status === 'abierta');
  const latest = DATASETS[0];
  return (
    <>
      <PageHeader
        eyebrow="Observatorio"
        title="¿Está todo bien ahora?"
        summary={`Estado de buoh al ${formatUtc(DEMO_NOW_UTC)}. Lo bueno y lo malo se muestran al mismo nivel.`}
      />

      <div className="w-grid w-grid--4">
        <Card title="Modo de ejecución" subtitle="Qué puede hacer el bot">
          <div className="w-stat">
            <ModeBadge mode={GLOBAL_STATUS.mode} showDescription />
            <p className="b-secondary w-small">Las señales son hipotéticas. Nada sale al bróker.</p>
          </div>
        </Card>
        <Card title="Salud del servicio" subtitle="Datos y persistencia">
          <div className="w-stat">
            <HealthBadge health={GLOBAL_STATUS.health} showDescription />
            <p className="b-secondary w-small">Es un eje distinto del modo.</p>
          </div>
        </Card>
        <Card title="Alertas abiertas" subtitle="Calidad de datos">
          <div className="w-stat">
            <span className="w-stat__value b-num">{String(openIncidents.length)}</span>
            <Link className="w-link" href="/datos/">
              Ver incidencias
            </Link>
          </div>
        </Card>
        <Card title="Último dataset" subtitle="Reproducible por su identificador">
          <div className="w-stat">
            <span className="b-num w-small">{latest?.id}</span>
            {latest?.verified === true ? (
              <Badge tone="aurora" icon="check">
                Reproducido
              </Badge>
            ) : (
              <Badge tone="naranja" icon="alertTriangle">
                Sin verificar
              </Badge>
            )}
          </div>
        </Card>
      </div>

      <div className="w-grid w-grid--wide">
        <Card
          title="Fuentes"
          subtitle="Cada fuente tiene su propio log y su propia salud"
          headingLevel={2}
        >
          <ul className="w-list">
            {SOURCES.map((source) => (
              <li key={source.id}>
                <div>
                  <div className="w-row">
                    <strong>{source.name}</strong>
                    {source.phase === '1' ? null : <Badge tone="niebla">Fase {source.phase}</Badge>}
                  </div>
                  <p className="b-muted w-small">{source.note}</p>
                  <p className="b-muted w-small">
                    Último dato: <span className="b-num">{formatUtcTime(source.lastDataUtc)}</span>
                  </p>
                </div>
                <HealthBadge health={source.health} />
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Alertas" subtitle="Incidencias abiertas y recientes" headingLevel={2}>
          <ul className="w-list">
            {INCIDENTS.slice(0, 3).map((incident) => (
              <li key={`${incident.type}-${incident.whenUtc}`}>
                <div>
                  <strong className="w-small">{INCIDENT_LABELS[incident.type]}</strong>
                  <p className="b-muted w-small">
                    <span className="b-num">{incident.symbol}</span> ·{' '}
                    {formatUtcTime(incident.whenUtc)} · {incident.status}
                  </p>
                </div>
                <SeverityTag severity={incident.severity} />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <SectionTitle>Bot shadow</SectionTitle>
      <div className="w-grid w-grid--wide">
        <Card title="Resultado hipotético de la semana" subtitle="Siempre con su contexto completo">
          <MetricWithContext
            label="Resultado neto hipotético"
            value="−1,1 %"
            context={SHADOW_CONTEXT}
          />
        </Card>
        <div className="w-stack">
          <Card title="Detener todo" subtitle="Kill switch global">
            <PhaseLock
              phase="4"
              title="Kill switch"
              description="Detendrá a la vez todas las estrategias, cuentas y órdenes. En modo shadow no hay órdenes que detener."
            />
          </Card>
        </div>
      </div>

      <SectionTitle>Últimas señales</SectionTitle>
      <div className="w-grid w-grid--3">
        {SIGNALS.map((signal) => (
          <SignalCard key={signal.id} signal={signal} />
        ))}
      </div>
    </>
  );
}
