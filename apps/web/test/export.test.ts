/**
 * Comprueba el sitio exportado (`out/`). `pnpm run test` y `verify` pasan por turbo, que construye
 * antes de probar; `pnpm --filter @buoh/web run test` a secas lee la última exportación.
 * Evidencia de V1-UI-001: cada pantalla muestra modo, salud y la marca de datos ficticios, y no
 * contiene formularios, contraseñas, recursos de terceros ni promesas prohibidas por la guía de marca.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOGO_FILES, LOGO_LOCKUP, LOGO_MIN, LOGO_WORDMARK } from '@buoh/design-system';
import { NAV_ITEMS } from '../src/navigation';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

// Los ayudantes de abajo (files, textOf, mainOf, pageOf) y las pruebas de logo, títulos y recursos
// externos están repetidos en apps/site/test/export.test.ts, con pequeñas diferencias en textOf
// (estado-del-codigo D-03).

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
    .replace(/\s+/g, ' ');
}

/** Solo el contenido de la página, sin la navegación ni la barra superior. */
function mainOf(html: string): string {
  const start = html.indexOf('<main');
  const end = html.indexOf('</main>');
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end);
}

// Frases prohibidas de la guía de marca §3. La misma lista está copiada en las pruebas del sitio y
// del móvil; si la guía cambia, hay que cambiar las tres (estado-del-codigo D-04).
const FORBIDDEN = [
  /ganancia garantizada/i,
  /sin riesgo/i,
  /dinero fácil/i,
  /hazte rico/i,
  /señal segura/i,
  /última oportunidad/i,
];

const pages = existsSync(OUT) ? files(OUT, '.html') : [];
const named = pages.map((p) => [p.replace(OUT, '')] as const);
const read = (page: string) => readFileSync(join(OUT, page), 'utf8');
const pageOf = (href: string) => (href === '/' ? 'index.html' : join(href.slice(1), 'index.html'));

describe('prototipo exportado (V1-UI-001)', () => {
  it('la exportación existe, con un identificador de build fijo', () => {
    expect(existsSync(join(OUT, 'index.html'))).toBe(true);
    expect(existsSync(join(OUT, '_next', 'static', 'buoh-prototipo'))).toBe(true);
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

  it('exporta una página por cada sección de la navegación', () => {
    for (const item of NAV_ITEMS) {
      expect(existsSync(join(OUT, pageOf(item.href))), item.href).toBe(true);
    }
  });

  it.each(named)('%s muestra modo, salud y datos ficticios', (page) => {
    const text = textOf(read(page));
    expect(text).toContain('Modo:');
    expect(text).toContain('Salud:');
    expect(text).toContain('Datos ficticios');
  });

  it.each(named)('%s no tiene formularios, contraseñas ni promesas', (page) => {
    const html = read(page);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/type="password"/i);
    expect(html).not.toMatch(/<input\b/i);
    for (const pattern of FORBIDDEN) {
      expect(textOf(html)).not.toMatch(pattern);
    }
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

  it.each(named)('%s no carga recursos de terceros', (page) => {
    const external = [...read(page).matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(external).toEqual([]);
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

  it('las secciones de Fase 4 tienen su candado en el contenido y solo controles desactivados', () => {
    for (const item of NAV_ITEMS.filter((i) => i.lockedUntil !== undefined)) {
      const main = mainOf(read(pageOf(item.href)));
      expect(textOf(main), item.href).toContain(`Disponible en Fase ${item.lockedUntil ?? ''}`);
      for (const match of main.matchAll(/<button\b[^>]*>/g)) {
        expect(match[0], item.href).toMatch(/disabled/);
      }
    }
  });

  it('solo la guía visual tiene botones activos, y son muestras', () => {
    for (const [page] of named) {
      const main = mainOf(read(page));
      const active = [...main.matchAll(/<button\b[^>]*>/g)].filter(
        (m) => !m[0].includes('disabled'),
      );
      if (page === join('guia', 'index.html')) {
        expect(textOf(main)).toContain('no hacen nada');
      } else {
        expect(active, page).toEqual([]);
      }
    }
  });

  it('toda cifra de desempeño va con su contexto completo', () => {
    for (const href of ['/', '/laboratorio/']) {
      const text = textOf(mainOf(read(pageOf(href))));
      for (const label of [
        'Origen',
        'Período',
        'Muestra',
        'Costes',
        'Pérdidas',
        'Drawdown',
        'Versión',
        'Limitaciones',
      ]) {
        expect(text, `${href} ${label}`).toContain(label);
      }
    }
    const lab = textOf(mainOf(read(pageOf('/laboratorio/'))));
    expect(lab.match(/Limitaciones:/g)?.length).toBe(3);
    expect(lab.match(/Origen: Backtest/g)?.length).toBe(3);
    expect(lab.match(/Pérdidas/g)?.length).toBe(3);
    expect(read(pageOf('/laboratorio/'))).toContain('id="evidencia-ruptura-v2"');
  });
});

// Los gráficos exportados (F2-CHART-001; concepto de interfaz §9). Las cifras esperadas salen de los
// datos ficticios de @buoh/prototype-data: 90 ticks desde las 14:29:06 UTC, uno cada 2 s, con un hueco
// de 6 ticks por la conexión perdida, y la curva de 121 puntos que termina en −0,4 %.
const NB = '\u00a0';

/** El nombre de cada gráfico de la página, que es su alternativa en texto. */
const chartLabels = (html: string) =>
  [...html.matchAll(/<div class="w-chart" role="img" aria-label="([^"]*)"/g)].map((m) => m[1]);

/**
 * La ruta de la línea de cada gráfico de la página, con el extremo redondo que dibuja un tick aislado
 * como un punto.
 */
const chartLines = (html: string) =>
  [
    ...html.matchAll(
      /<path d="([^"]*)" fill="none" stroke="var\(--b-chart-line\)" stroke-width="1\.75" stroke-linecap="round"/g,
    ),
  ].map((m) => m[1] ?? '');

/** El texto de la nota visible de la peor caída, fuera del `aria-label`. */
const lossNotes = (html: string) =>
  [...html.matchAll(/<span class="w-chart__note w-chart__note--loss"[^>]*>([^<]*)<\/span>/g)].map(
    (m) => m[1],
  );

describe('gráficos exportados (F2-CHART-001)', () => {
  it('Mercados: la alternativa del gráfico de ticks sale de sus datos, con el hueco y su motivo', () => {
    expect(chartLabels(read(pageOf('/mercados/')))).toEqual([
      'Precio ficticio de Volatility 100 entre las 14:29:06 y las 14:32:04 UTC: 84 ticks, el primero a 1040.00 y el último a 1040.01, entre 1036.99 y 1045.99. Un hueco de 6 ticks, de las 14:30:00 a las 14:30:10: conexión perdida.',
    ]);
  });

  it('Mercados: la línea se corta una sola vez, en el hueco, que lleva su banda y su nota', () => {
    const html = read(pageOf('/mercados/'));
    const lines = chartLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.match(/M/g)).toHaveLength(2);
    expect(html.match(/<rect\b[^>]*stroke="var\(--b-chart-gap\)"/g)).toHaveLength(1);
    expect(html).toContain(`Hueco: 6 ticks (12${NB}s) · conexión perdida`);
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it('Laboratorio: la peor caída va en % del capital inicial en el gráfico, en su alternativa y en su contexto', () => {
    const html = read(pageOf('/laboratorio/'));
    expect(chartLabels(html)).toEqual([
      `Curva ficticia de resultado acumulado, en % del capital inicial, del 1 oct al 15 oct: empieza en 0,0${NB}% y termina en −0,4${NB}%, con un máximo de 1,0${NB}% y un mínimo de −2,6${NB}%. Peor caída: −3,6${NB}%, de 1,0${NB}% a −2,6${NB}%.`,
    ]);
    expect(lossNotes(html)).toEqual([`Peor caída: −3,6${NB}%`]);
    // `textOf` junta los espacios, también el de no separación, así que aquí el contexto lleva uno normal.
    const text = textOf(mainOf(html));
    expect(text).toContain('Drawdown máximo −3,6 %');
    expect(text).not.toMatch(/\bpts\b|puntos porcentuales/);
    expect(chartLines(html)).toHaveLength(1);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
