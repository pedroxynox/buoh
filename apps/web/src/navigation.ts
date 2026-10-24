import type { IconName } from '@buoh/design-system';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** Fase en que empieza toda la sección, si es posterior a Fase 3 (concepto de interfaz §2). */
  readonly lockedUntil?: string;
  /** Aparece en la barra inferior del móvil. */
  readonly primary: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Observatorio', icon: 'eye', primary: true },
  { href: '/mercados/', label: 'Mercados', icon: 'chart', primary: true },
  { href: '/datos/', label: 'Datos', icon: 'database', primary: false },
  { href: '/laboratorio/', label: 'Laboratorio', icon: 'flask', primary: true },
  { href: '/senales/', label: 'Señales', icon: 'radar', primary: true },
  { href: '/ejecucion/', label: 'Ejecución', icon: 'send', lockedUntil: '4', primary: false },
  { href: '/riesgo/', label: 'Riesgo', icon: 'shield', lockedUntil: '4', primary: false },
  { href: '/auditoria/', label: 'Auditoría', icon: 'book', primary: false },
  { href: '/conexiones/', label: 'Conexiones', icon: 'plug', primary: false },
  { href: '/guia/', label: 'Guía visual', icon: 'palette', primary: true },
];
