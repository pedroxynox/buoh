/**
 * Comprueba el sitio exportado (`out/`). `pnpm run test` y `verify` construyen antes de probar;
 * `pnpm --filter @buoh/site run test` a secas lee la última exportación.
 * Evidencia de V1-SITE-001: sin formularios, registro, pagos, métricas de desempeño ni recursos de
 * terceros, y con aviso de riesgo y nota de marcas en todas las páginas.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOGO_FILES, LOGO_LOCKUP, LOGO_MIN, LOGO_WORDMARK } from '@buoh/design-system';
import { PAGES, RISK_SHORT, TRADEMARK_NOTE } from '../src/content';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

// Ayudantes y pruebas comunes con apps/web/test/export.test.ts (estado-del-codigo D-03). Este
// textOf, a diferencia del de la web, también decodifica entidades HTML.

function files(dir: string, extension: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return files(path, extension);
    }
    return name.endsWith(extension) ? [path] : [];
  });
}

function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function mainOf(html: string): string {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end);
}

/**
 * Promesas y presiones prohibidas. Las seis primeras son las de la guía de marca §3, copiadas
 * también en las pruebas de la web y el móvil; «regístrate», «suscríbete» y «compra ahora» solo
 * están aquí y ninguna guía las nombra (estado-del-codigo D-04).
 */
const FORBIDDEN = [
  /ganancia garantizada/i,
  /sin riesgo/i,
  /dinero fácil/i,
  /hazte rico/i,
  /señal segura/i,
  /última oportunidad/i,
  /regístrate/i,
  /suscríbete/i,
  /compra ahora/i,
];

const pages = existsSync(OUT) ? files(OUT, '.html') : [];
const named = pages.map((p) => [p.replace(OUT, '')] as const);
const read = (page: string) => readFileSync(join(OUT, page), 'utf8');
const pageOf = (href: string) => (href === '/' ? 'index.html' : join(href.slice(1), 'index.html'));

describe('sitio exportado (V1-SITE-001)', () => {
  it('exporta cada página del menú, con un identificador de build fijo', () => {
    for (const page of PAGES) {
      expect(existsSync(join(OUT, pageOf(page.href))), page.href).toBe(true);
    }
    expect(existsSync(join(OUT, '_next', 'static', 'buoh-sitio'))).toBe(true);
  });

  it.each(named)('%s lleva el aviso de riesgo y la nota de marcas', (page) => {
    const text = textOf(read(page));
    expect(text).toContain(RISK_SHORT);
    expect(text).toContain(TRADEMARK_NOTE);
    expect(read(page)).toContain('href="/aviso-de-riesgo/"');
  });

  it.each(named)('%s no tiene formularios, campos, pagos ni promesas', (page) => {
    const html = read(page);
    expect(html).not.toMatch(/<(form|input|select|textarea)\b/i);
    expect(html).not.toMatch(/<button\b/i);
    const text = textOf(html);
    for (const pattern of FORBIDDEN) {
      expect(text).not.toMatch(pattern);
    }
  });

  // Aproximación: una métrica de desempeño casi siempre lleva un porcentaje o una cifra con signo.
  it.each(named)('%s no muestra métricas de desempeño', (page) => {
    const text = textOf(mainOf(read(page)));
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/[+−-]\s?\d+[,.]\d/);
  });

  it.each(named)('%s ordena sus títulos sin saltos', (page) => {
    const levels = [...mainOf(read(page)).matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => {
      if (i > 0) {
        expect(level, `h${String(levels[i - 1] ?? 0)} → h${String(level)}`).toBeLessThanOrEqual(
          (levels[i - 1] ?? 0) + 1,
        );
      }
    });
  });

  it.each(named)('%s no carga recursos de terceros y sus enlaces existen', (page) => {
    const html = read(page);
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(external).toEqual([]);
    for (const match of html.matchAll(/<a\b[^>]*href="(\/[^"#]*)(#[^"]*)?"/g)) {
      const href = match[1] ?? '';
      expect(existsSync(join(OUT, pageOf(href))), `${page} → ${href}`).toBe(true);
    }
  });

  it.each(named)('%s lleva el logotipo vectorizado sin bajar del ancho mínimo', (page) => {
    const html = read(page);
    const viewBox = LOGO_LOCKUP.viewBox.replace(/\./g, '\\.');
    const lockups = [...html.matchAll(new RegExp(`<svg\\b[^>]*viewBox="${viewBox}"[^>]*>`, 'g'))];
    expect(lockups.length).toBeGreaterThan(0);
    for (const [tag] of lockups) {
      expect(Number(/\swidth="([\d.]+)"/.exec(tag)?.[1]), tag).toBeGreaterThanOrEqual(
        LOGO_MIN.lockupPx,
      );
    }
    expect(html).toContain(LOGO_WORDMARK.d);
  });

  it('el favicon es el icono del sistema de diseño', () => {
    expect(readFileSync(new URL('../app/icon.svg', import.meta.url), 'utf8')).toBe(
      LOGO_FILES['buoh-icono.svg'],
    );
  });

  it('las hojas de estilo no cargan recursos de terceros', () => {
    const sheets = files(OUT, '.css');
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      const css = readFileSync(sheet, 'utf8');
      expect(css, sheet).not.toMatch(/url\(\s*['"]?https?:/i);
      expect(css, sheet).not.toMatch(/@import\s+(url\()?\s*['"]?https?:/i);
    }
  });

  it('el JavaScript del sitio no usa cookies, almacenamiento ni envíos a terceros', () => {
    const scripts = files(join(OUT, '_next'), '.js');
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const js = readFileSync(script, 'utf8');
      for (const api of [
        'document.cookie',
        'localStorage',
        'sessionStorage',
        'indexedDB',
        'sendBeacon',
      ]) {
        expect(js.includes(api), `${script} usa ${api}`).toBe(false);
      }
    }
  });

  it('el sitio no se indexa hasta que se decida publicarlo', () => {
    for (const [page] of named) {
      expect(read(page), page).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    }
  });
});
