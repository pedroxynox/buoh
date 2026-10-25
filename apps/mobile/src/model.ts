/**
 * Qué muestra cada pestaña del prototipo móvil. Es la parte comprobable sin un teléfono: las pruebas
 * verifican estas reglas contra el concepto de interfaz y el catálogo de funciones.
 */
import type { IconName, PerformanceContext } from '@buoh/design-system';
import {
  APPROVED_VALIDATION,
  INCIDENTS,
  SHADOW_CONTEXT,
  SIGNALS,
  SPLITS_CONTEXT,
  STRATEGIES,
  type IncidentRow,
} from '@buoh/prototype-data';

export type TabId = 'inicio' | 'senales' | 'alertas' | 'evidencia' | 'mas';

export interface Tab {
  readonly id: TabId;
  readonly label: string;
  readonly icon: IconName;
}

/** Pestañas de la app (concepto de interfaz §7): Observatorio, Señales, Alertas, Evidencia y Más. */
export const TABS: readonly Tab[] = [
  { id: 'inicio', label: 'Inicio', icon: 'eye' },
  { id: 'senales', label: 'Señales', icon: 'radar' },
  { id: 'alertas', label: 'Alertas', icon: 'bell' },
  { id: 'evidencia', label: 'Evidencia', icon: 'book' },
  { id: 'mas', label: 'Más', icon: 'layers' },
];

/** Alertas: primero las condiciones abiertas, después el resto, de la más reciente a la más antigua. */
export function alertsInOrder(): readonly IncidentRow[] {
  return [...INCIDENTS].sort((a, b) => {
    const openA = a.status === 'abierta' ? 0 : 1;
    const openB = b.status === 'abierta' ? 0 : 1;
    return openA - openB || Date.parse(b.whenUtc) - Date.parse(a.whenUtc);
  });
}

export const OPEN_ALERTS = INCIDENTS.filter((incident) => incident.status === 'abierta').length;

export const PAUSED_STRATEGIES = STRATEGIES.filter((strategy) => strategy.lifecycle === 'paused');

/** En el inicio solo caben las dos señales más recientes. */
export const LATEST_SIGNALS = SIGNALS.slice(0, 2);

const validation = APPROVED_VALIDATION.find((row) => row.version === SHADOW_CONTEXT.version);

/** Evidencia de la estrategia en shadow: su resultado y la validación que la aprobó. */
export const SHADOW_EVIDENCE: {
  readonly context: PerformanceContext;
  readonly validation: typeof validation;
  readonly validationContext: PerformanceContext | undefined;
} = {
  context: SHADOW_CONTEXT,
  validation,
  validationContext:
    validation === undefined
      ? undefined
      : {
          source: SPLITS_CONTEXT.source,
          period: validation.window,
          sample: validation.sample,
          costs: SPLITS_CONTEXT.costs,
          losses: validation.losses,
          drawdown: validation.drawdown,
          version: validation.version,
          limitations: SPLITS_CONTEXT.limitations,
        },
};

/**
 * Lo que el móvil no hace, según el catálogo de funciones: se explica en «Más» y no tiene controles.
 * Pedir el modo real y cambiar políticas exigen web o escritorio.
 */
export const ONLY_ON_WEB = [
  'Editar hipótesis, estrategias y políticas de riesgo',
  'Pedir que una estrategia pase al modo real',
  'Revisar datasets y la auditoría completa',
] as const;

/** Funciones de fases posteriores que el móvil enseña con candado. */
export const LOCKED_ON_MOBILE = [
  {
    phase: '4',
    title: 'Detener todo (kill switch)',
    description:
      'Detendrá a la vez todas las estrategias, cuentas y órdenes, también desde el móvil. En modo shadow no hay órdenes que detener.',
  },
  {
    phase: '4',
    title: 'Autorizaciones de cuenta',
    description:
      'Revisar y revocar la conexión de una cuenta demo, con confirmación en el servidor.',
  },
] as const;
