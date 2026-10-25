/**
 * Archivos SVG del logotipo (assets/), generados a partir de los trazados de `logo.ts` y de la paleta.
 * `pnpm --filter @buoh/design-system run logo:write` los vuelve a escribir; una prueba comprueba que
 * los archivos del repositorio coinciden con este texto.
 */
import { LOGO_LOCKUP, LOGO_SYMBOL, LOGO_WORDMARK } from './logo.js';
import { palette } from './tokens.js';

/** Tintas de cada versión (guía §4). */
export const LOGO_INKS = {
  color: { mark: palette.boreal[400], detail: palette.luna[200] },
  dia: { mark: palette.boreal[700], detail: palette.noche[850] },
  tile: palette.noche[900],
} as const;

function svg(viewBox: string, width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${String(width)}" height="${String(height)}" role="img" aria-label="buoh">\n${body}</svg>\n`;
}

const path = (fill: string, d: string) => `  <path fill="${fill}" d="${d}"/>\n`;

function symbolBody(ink: 'color' | 'dia' | 'mono'): string {
  if (ink === 'mono') {
    return path('currentColor', LOGO_SYMBOL.mono);
  }
  return (
    path(LOGO_INKS[ink].mark, LOGO_SYMBOL.primary) + path(LOGO_INKS[ink].detail, LOGO_SYMBOL.detail)
  );
}

function lockup(ink: 'color' | 'dia' | 'mono'): string {
  const word = ink === 'mono' ? 'currentColor' : LOGO_INKS[ink].detail;
  return svg(
    LOGO_LOCKUP.viewBox,
    LOGO_LOCKUP.width,
    LOGO_LOCKUP.height,
    symbolBody(ink) + path(word, LOGO_WORDMARK.d),
  );
}

const symbol = (ink: 'color' | 'dia' | 'mono') =>
  svg(LOGO_SYMBOL.viewBox, LOGO_SYMBOL.width, LOGO_SYMBOL.height, symbolBody(ink));

/** Icono de app y favicon: el símbolo centrado sobre una baldosa noche de 256, con 40 de margen. */
function icon(): string {
  const side = 256;
  const scale = (side - 80) / LOGO_SYMBOL.height;
  const x = (side - LOGO_SYMBOL.width * scale) / 2;
  const y = (side - LOGO_SYMBOL.height * scale) / 2;
  const body =
    `  <rect width="${String(side)}" height="${String(side)}" rx="56" fill="${LOGO_INKS.tile}"/>\n` +
    `  <g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(5)})">\n` +
    symbolBody('color').replace(/^/gm, '  ').replace(/ {2}$/, '') +
    '  </g>\n';
  return svg(`0 0 ${String(side)} ${String(side)}`, side, side, body);
}

/** Nombre de archivo y contenido de cada versión del logotipo. */
export const LOGO_FILES: Readonly<Record<string, string>> = {
  'buoh-logo.svg': lockup('color'),
  'buoh-logo-dia.svg': lockup('dia'),
  'buoh-logo-mono.svg': lockup('mono'),
  'buoh-simbolo.svg': symbol('color'),
  'buoh-simbolo-dia.svg': symbol('dia'),
  'buoh-simbolo-mono.svg': symbol('mono'),
  'buoh-palabra.svg': svg(
    LOGO_WORDMARK.viewBox,
    LOGO_WORDMARK.width,
    LOGO_WORDMARK.height,
    path('currentColor', LOGO_WORDMARK.d),
  ),
  'buoh-icono.svg': icon(),
};
