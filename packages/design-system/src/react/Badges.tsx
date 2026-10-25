import type { ExecutionMode, ServiceHealth } from '@buoh/contracts';
import type { ReactNode } from 'react';
import type { IconName } from '../icons.js';
import {
  EXECUTION_MODE_PRESENTATION,
  SERVICE_HEALTH_PRESENTATION,
  SEVERITY_PRESENTATION,
  type Severity,
  type StatusPresentation,
} from '../status.js';
import type { Tone } from '../tokens.js';
import { Icon } from './Icon.js';

export interface BadgeProps {
  readonly tone?: Tone;
  readonly icon?: IconName;
  readonly strong?: boolean;
  readonly title?: string;
  readonly children: ReactNode;
}

/** Insignia genérica: texto obligatorio, icono y tono opcionales. */
export function Badge({ tone, icon, strong = false, title, children }: BadgeProps) {
  return (
    <span className={strong ? 'b-badge b-badge--strong' : 'b-badge'} data-tone={tone} title={title}>
      {icon === undefined ? null : <Icon name={icon} />}
      {children}
    </span>
  );
}

function StatusBadge({
  axis,
  presentation,
  showDescription,
  strong,
}: {
  readonly axis: string;
  readonly presentation: StatusPresentation;
  readonly showDescription: boolean;
  readonly strong?: boolean;
}) {
  return (
    <Badge
      tone={presentation.tone}
      icon={presentation.icon}
      strong={strong ?? false}
      title={`${axis}: ${presentation.label}. ${presentation.description}`}
    >
      <span className="b-visually-hidden">{axis}: </span>
      {presentation.label}
      {showDescription ? (
        <span className="b-badge__detail">· {presentation.description}</span>
      ) : null}
    </Badge>
  );
}

/** Modo de ejecución (`disabled | shadow | demo | real`). Eje distinto de la salud del servicio. */
export function ModeBadge({
  mode,
  showDescription = false,
}: {
  readonly mode: ExecutionMode;
  readonly showDescription?: boolean;
}) {
  return (
    <StatusBadge
      axis="Modo"
      presentation={EXECUTION_MODE_PRESENTATION[mode]}
      showDescription={showDescription}
      strong={mode === 'real'}
    />
  );
}

/** Salud del servicio (los seis estados de `HealthReport`). */
export function HealthBadge({
  health,
  showDescription = false,
}: {
  readonly health: ServiceHealth;
  readonly showDescription?: boolean;
}) {
  return (
    <StatusBadge
      axis="Salud"
      presentation={SERVICE_HEALTH_PRESENTATION[health]}
      showDescription={showDescription}
    />
  );
}

export function SeverityTag({ severity }: { readonly severity: Severity }) {
  return (
    <StatusBadge
      axis="Severidad"
      presentation={SEVERITY_PRESENTATION[severity]}
      showDescription={false}
      strong={severity === 'critical'}
    />
  );
}
