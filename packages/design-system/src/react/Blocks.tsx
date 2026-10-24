import type { ExecutionMode } from '@buoh/contracts';
import type { ReactNode } from 'react';
import { ModeBadge } from './Badges.js';
import { Icon } from './Icon.js';

export function Card({
  title,
  subtitle,
  actions,
  raised = false,
  children,
}: {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
  readonly raised?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section className={raised ? 'b-card b-card--raised' : 'b-card'}>
      {title === undefined && actions === undefined ? null : (
        <header className="b-card__header">
          <div>
            {title === undefined ? null : <h3 className="b-card__title">{title}</h3>}
            {subtitle === undefined ? null : <p className="b-card__subtitle">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

/** Aviso fijo del prototipo: todo lo que se ve es ficticio (ADR-0008 §2). */
export function FictitiousDataNotice() {
  return (
    <span className="b-notice" data-tone="cielo" role="note">
      <Icon name="info" />
      Datos ficticios
    </span>
  );
}

/** Función que llega en una fase posterior: se ve, pero no tiene controles activos. */
export function PhaseLock({
  phase,
  title,
  children,
}: {
  readonly phase: string;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="b-phase-lock" role="note">
      <div className="b-phase-lock__title">
        <Icon name="lock" />
        <span>
          {title} · Disponible en Fase {phase}
        </span>
      </div>
      {children === undefined ? null : <div>{children}</div>}
    </div>
  );
}

/**
 * Contexto obligatorio de toda cifra de desempeño (fundamentos de buoh, guía §3).
 * Los tipos impiden mostrar una métrica sin estos campos.
 */
export interface PerformanceContext {
  readonly mode: ExecutionMode | 'backtest';
  readonly period: string;
  readonly sample: string;
  readonly costs: string;
  readonly losses: string;
  readonly drawdown: string;
  readonly version: string;
  readonly limitations: string;
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
  return (
    <div className="b-metric">
      <div className="b-metric__label">{label}</div>
      <div className="b-metric__value">{value}</div>
      <dl className="b-metric__context">
        <div>
          <dt>Modo</dt>
          <dd>
            {context.mode === 'backtest' ? (
              <span className="b-badge" data-tone="niebla">
                Backtest
              </span>
            ) : (
              <ModeBadge mode={context.mode} />
            )}
          </dd>
        </div>
        <div>
          <dt>Período</dt>
          <dd>{context.period}</dd>
        </div>
        <div>
          <dt>Muestra</dt>
          <dd>{context.sample}</dd>
        </div>
        <div>
          <dt>Costes</dt>
          <dd>{context.costs}</dd>
        </div>
        <div>
          <dt>Pérdidas</dt>
          <dd>{context.losses}</dd>
        </div>
        <div>
          <dt>Drawdown máximo</dt>
          <dd>{context.drawdown}</dd>
        </div>
        <div>
          <dt>Versión</dt>
          <dd className="b-num">{context.version}</dd>
        </div>
      </dl>
      <p className="b-metric__limits">
        <strong>Limitaciones:</strong> {context.limitations}
      </p>
    </div>
  );
}
