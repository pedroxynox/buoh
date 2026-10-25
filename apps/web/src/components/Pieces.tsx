import { Badge, Icon, ModeBadge } from '@buoh/design-system/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatUtcTime, SIGNAL_STATUS, type SignalRow } from '@buoh/prototype-data';

/** Metadatos obligatorios de toda vista de datos (README, identidad de diseño). */
export function DataMeta({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="w-meta">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tarjeta de señal: estrategia, versión, condición, tiempos, modo, calidad y evidencia (concepto §4). */
export function SignalCard({ signal }: { readonly signal: SignalRow }) {
  const status = SIGNAL_STATUS[signal.status];
  return (
    <article className="w-signal" aria-labelledby={`${signal.id}-t`}>
      <header className="w-signal__header">
        <div>
          <h3 id={`${signal.id}-t`} className="w-signal__title">
            {signal.strategy} <span className="b-num b-muted">{signal.version}</span>
          </h3>
          <p className="b-muted w-small">
            <span className="b-num">{signal.symbol}</span> · {signal.condition}
          </p>
        </div>
        <ModeBadge mode={signal.mode} />
      </header>
      <p className="w-signal__direction">{signal.direction}</p>
      <dl className="w-signal__facts">
        <div>
          <dt>Emitida</dt>
          <dd className="b-num">{formatUtcTime(signal.issuedUtc)}</dd>
        </div>
        <div>
          <dt>Vence</dt>
          <dd className="b-num">{formatUtcTime(signal.expiresUtc)}</dd>
        </div>
        <div>
          <dt>Calidad</dt>
          <dd>
            {signal.quality === 'completa' ? (
              <Badge tone="aurora" icon="check">
                Datos completos
              </Badge>
            ) : (
              <Badge tone="naranja" icon="alertTriangle">
                Datos degradados
              </Badge>
            )}
          </dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>
            <Badge tone={status.tone} icon={status.icon}>
              {status.label}
            </Badge>
          </dd>
        </div>
      </dl>
      <footer className="w-signal__footer">
        <span className="b-muted w-small">Una señal no es una orden.</span>
        <Link className="w-link" href={signal.evidenceHref}>
          Ver evidencia <Icon name="arrowUpRight" />
        </Link>
      </footer>
    </article>
  );
}

export function SectionTitle({ children }: { readonly children: ReactNode }) {
  return <h2 className="w-section-title">{children}</h2>;
}
