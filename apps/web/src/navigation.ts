import type { IconName } from '@buoh/design-system';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Etiqueta corta para la barra inferior, si la normal no cabe. */
  readonly shortLabel?: string;
  readonly icon: IconName;
  /** Fase en que empieza toda la sección, si es posterior a Fase 3 (concepto de interfaz §2). */
  readonly lockedUntil?: string;
  /** Aparece en la barra inferior del móvil; el resto va en el menú «Más». */
  readonly primary: boolean;
  /**
   * La sección muestra datos reales en la web servida por la API, así que allí no lleva la marca
   * «Datos ficticios» (concepto de interfaz §2 y §10). El escritorio la lleva siempre.
   */
  readonly realInApi?: true;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/',
    label: 'Observatorio',
    shortLabel: 'Inicio',
    icon: 'eye',
    primary: true,
    realInApi: true,
  },
  { href: '/mercados/', label: 'Mercados', icon: 'chart', primary: true, realInApi: true },
  { href: '/datos/', label: 'Datos', icon: 'database', primary: false },
  { href: '/laboratorio/', label: 'Laboratorio', icon: 'flask', primary: true },
  { href: '/senales/', label: 'Señales', icon: 'radar', primary: true },
  { href: '/ejecucion/', label: 'Ejecución', icon: 'send', lockedUntil: '4', primary: false },
  { href: '/riesgo/', label: 'Riesgo', icon: 'shield', lockedUntil: '4', primary: false },
  { href: '/auditoria/', label: 'Auditoría', icon: 'book', primary: false, realInApi: true },
  { href: '/conexiones/', label: 'Conexiones', icon: 'plug', primary: false },
  { href: '/guia/', label: 'Guía visual', icon: 'palette', primary: false },
];

/** Las pantallas de la web servida por la API que no muestran datos: el acceso y el enlace de alta. */
const API_SCREENS_WITHOUT_DATA: readonly string[] = ['/acceso/', '/enlace/'];

/**
 * Si la ruta lleva la marca «Datos ficticios» en la web servida por la API: todas menos las secciones
 * con datos reales y las pantallas sin datos (concepto de interfaz §2). Compara la ruta exacta, con
 * barra final como `NavLink`, así que una ruta que no existe, la del 404, la lleva.
 */
export function showsFictitiousDataInApi(pathname: string): boolean {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (API_SCREENS_WITHOUT_DATA.includes(normalized)) {
    return false;
  }
  return !NAV_ITEMS.some((item) => item.realInApi === true && item.href === normalized);
}
