import type { ReactNode } from 'react';
import type { EvidenceSource, PerformanceContext } from '../evidence.js';
import { Badge, ModeBadge } from './Badges.js';
import { Icon } from './Icon.js';

export function Card({
  title,
  subtitle,
  actions,
  headingLevel = 3,
  raised = false,
  children,
}: {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  /** Nivel del título según su lugar en la página. */
  readonly headingLevel?: 2 | 3 | 4;
  readonly raised?: boolean;
  readonly children: ReactNode;
}) {
  const Heading = `h${String(headingLevel)}` as 'h2' | 'h3' | 'h4';
  return (
    <section className={raised ? 'b-card b-card--raised' : 'b-card'}>
      {title === undefined && actions === undefined ? null : (
        <header className="b-card__header">
          <div>
            {title === undefined ? null : <Heading className="b-card__title">{title}</Heading>}
            {subtitle === undefined ? null : <p className="b-card__subtitle">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Aviso fijo del prototipo: todo lo que se ve es ficticio (ADR-0008 §2).
 * Usa el estilo neutro, sin tono de estado, para no confundirse con la salud del servicio.
 */
export function FictitiousDataNotice() {
  return (
    <span className="b-notice" role="note">
      <Icon name="document" />
      Datos ficticios
    </span>
  );
}

/** Función que llega en una fase posterior: se ve, pero no tiene controles. Solo admite texto. */
export function PhaseLock({
  phase,
  title,
  description,
}: {
  readonly phase: string;
  readonly title: string;
  readonly description?: string;
}) {
  return (
    <div className="b-phase-lock" role="note">
      <div className="b-phase-lock__title">
        <Icon name="lock" />
        <span>
          {title} · Disponible en Fase {phase}
        </span>
      </div>
      {description === undefined ? null : <p>{description}</p>}
    </div>
  );
}

export function EvidenceSourceBadge({ source }: { readonly source: EvidenceSource }) {
  return source === 'backtest' ? (
    <Badge tone="niebla" icon="flask" title="Origen: backtest sobre datos pasados">
      <span className="b-visually-hidden">Origen: </span>
      Backtest
    </Badge>
  ) : (
    <ModeBadge mode={source} />
  );
}

export function MetricWithContext({
  label,
  value,
  context,
}: {
  readonly label: string;
  readonly value: string;
  readonly context: PerformanceContext;
}) {
  const rows: readonly (readonly [string, ReactNode])[] = [
    ['Origen', <EvidenceSourceBadge key="source" source={context.source} />],
    ['Período', context.period],
    ['Muestra', context.sample],
    ['Costes', context.costs],
    ['Pérdidas', context.losses],
    ['Drawdown máximo', context.drawdown],
    ['Versión', context.version],
  ];
  return (
    <div className="b-metric">
      <div className="b-metric__label">{label}</div>
      <div className="b-metric__value">{value}</div>
      <dl className="b-metric__context">
        {rows.map(([term, detail]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{detail}</dd>
          </div>
        ))}
      </dl>
      <p className="b-metric__limits">
        <strong>Limitaciones:</strong> {context.limitations}
      </p>
    </div>
  );
}
