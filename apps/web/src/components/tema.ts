/**
 * El tema de la web servida por la API (`F2-UI-001`; concepto de interfaz §13): noche o día, que se
 * guarda por cuenta con `POST /api/v1/preferencias` (ADR-0019 §7). Los contratos los llaman `night`
 * y `day`, y el sistema de diseño, `data-theme="noche"` y `"dia"` (guía de marca). La página se abre
 * con noche, el tema por defecto, y cambia al de la cuenta cuando llega su preferencia.
 */
import type { AccountPreferences, Theme } from '@buoh/contracts';

/** El valor de `data-theme` de cada tema del contrato. */
export const THEME_ATTRIBUTE: Readonly<Record<Theme, 'noche' | 'dia'>> = {
  night: 'noche',
  day: 'dia',
};

/** El esquema de color de cada tema, para los controles nativos del navegador. */
const COLOR_SCHEME: Readonly<Record<Theme, 'dark' | 'light'>> = {
  night: 'dark',
  day: 'light',
};

/** El elemento que lleva el tema: en el navegador, `document.documentElement`. */
export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  readonly style: { colorScheme: string };
}

/** Pone el tema en la página. */
export function applyTheme(root: ThemeRoot, theme: Theme): void {
  root.setAttribute('data-theme', THEME_ATTRIBUTE[theme]);
  root.style.colorScheme = COLOR_SCHEME[theme];
}

/** El otro tema: el que elige el botón del menú. */
export function otherTheme(theme: Theme): Theme {
  return theme === 'night' ? 'day' : 'night';
}

/** Lo que dice el botón del menú con el tema `theme` puesto: el cambio que hace. */
export function themeToggleLabel(theme: Theme): string {
  return theme === 'night' ? 'Usar el tema día' : 'Usar el tema noche';
}

/**
 * La respuesta de `GET` y `POST /api/v1/preferencias` (`AccountPreferences`) si cumple el contrato,
 * o `null`. Como las demás lecturas del navegador, no usa los esquemas de `@buoh/contracts`, cuya
 * entrada principal carga módulos de Node: repite su regla, un objeto estricto con un tema que existe.
 * `test/tema.test.ts` la contrasta con el esquema.
 */
export function readAccountPreferences(value: unknown): AccountPreferences | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  const { theme } = value as { theme?: unknown };
  return keys.length === 1 && keys[0] === 'theme' && (theme === 'night' || theme === 'day')
    ? { theme }
    : null;
}
