import type { ExecutionMode, ServiceHealth, severitySchema } from '@buoh/contracts';
import type { IconName } from './icons.js';
import type { Tone } from './tokens.js';

/** Severidad de una incidencia, tomada del contrato. */
export type Severity = (typeof severitySchema.options)[number];

/** Cómo se presenta un estado: siempre con texto e icono, el color solo acompaña (guía §5). */
export interface StatusPresentation {
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
  readonly tone: Tone;
}

export const EXECUTION_MODE_PRESENTATION: Readonly<Record<ExecutionMode, StatusPresentation>> = {
  disabled: {
    label: 'Desactivado',
    description: 'Ninguna señal se convierte en intención',
    icon: 'circleSlash',
    tone: 'niebla',
  },
  shadow: {
    label: 'Shadow',
    description: 'Hipotético, sin dinero',
    icon: 'moon',
    tone: 'violeta',
  },
  demo: {
    label: 'Demo',
    description: 'Dinero de práctica',
    icon: 'playCircle',
    tone: 'cian',
  },
  real: {
    label: 'Real',
    description: 'Dinero real',
    icon: 'banknote',
    tone: 'rosa',
  },
};

export const SERVICE_HEALTH_PRESENTATION: Readonly<Record<ServiceHealth, StatusPresentation>> = {
  starting: {
    label: 'Iniciando',
    description: 'Todavía no hay datos persistidos',
    icon: 'circleDashed',
    tone: 'cielo',
  },
  healthy: {
    label: 'Saludable',
    description: 'Datos y persistencia verificados',
    icon: 'check',
    tone: 'aurora',
  },
  degraded: {
    label: 'Degradado',
    description: 'Funciona con problemas de calidad visibles',
    icon: 'alertTriangle',
    tone: 'naranja',
  },
  recovering: {
    label: 'Recuperando',
    description: 'Reconectando y comprobando continuidad',
    icon: 'rotate',
    tone: 'cielo',
  },
  paused: {
    label: 'En pausa',
    description: 'Entrada detenida, por protección o a pedido',
    icon: 'pauseCircle',
    tone: 'niebla',
  },
  failed: {
    label: 'Fallido',
    description: 'Necesita intervención',
    icon: 'xOctagon',
    tone: 'rojo',
  },
};

export const SEVERITY_PRESENTATION: Readonly<Record<Severity, StatusPresentation>> = {
  info: { label: 'Info', description: 'Para tener en cuenta', icon: 'info', tone: 'cielo' },
  warning: {
    label: 'Aviso',
    description: 'Puede afectar la calidad',
    icon: 'alertTriangle',
    tone: 'naranja',
  },
  error: {
    label: 'Error',
    description: 'Afecta datos u operación',
    icon: 'xOctagon',
    tone: 'rojo',
  },
  critical: {
    label: 'Crítico',
    description: 'Problema grave que exige atención',
    icon: 'xOctagon',
    tone: 'rojo',
  },
};
