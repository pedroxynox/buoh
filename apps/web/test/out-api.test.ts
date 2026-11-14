/**
 * Evidencia de la variante servida por la API (`out-api`, ADR-0019 §9 y §14): trae las pantallas de
 * inicio de sesión y de enlace de alta, con los atributos que esperan los gestores de contraseñas, y
 * las insignias de modo y salud en la barra superior de cada página. Desde F2.4 (concepto de interfaz
 * §10), el Observatorio y la insignia de salud piden la salud real a la API, el modo es `disabled`, y
 * la marca de datos ficticios solo va en las secciones que siguen con ellos (`F2-UI-001`). Como el
 * resto del prototipo, no tiene direcciones absolutas ni recursos de terceros.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../src/navigation';

const OUT_API = fileURLToPath(new URL('../out-api/', import.meta.url));

function files(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, extension);
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

const read = (parts: readonly string[]) => readFileSync(join(OUT_API, ...parts), 'utf8');
const pageOf = (href: string) =>
  href === '/' ? ['index.html'] : [...href.split('/').filter((part) => part !== ''), 'index.html'];

/** Solo la barra superior de la página. */
function topBarOf(html: string): string {
  const start = html.indexOf('<header class="w-topbar"');
  const end = html.indexOf('</header>', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end);
}

describe('variante servida por la API (out-api)', () => {
  it('existe, con las pantallas de acceso y de enlace', () => {
    expect(existsSync(join(OUT_API, 'index.html'))).toBe(true);
    expect(existsSync(join(OUT_API, 'acceso', 'index.html'))).toBe(true);
    expect(existsSync(join(OUT_API, 'enlace', 'index.html'))).toBe(true);
    expect(existsSync(join(OUT_API, '_next', 'static', 'buoh-prototipo'))).toBe(true);
  });

  it('el inicio de sesión trae el formulario con los atributos de los gestores de contraseñas', () => {
    const html = read(['acceso', 'index.html']);
    expect(html).toMatch(/<form\b/i);
    expect(html).toMatch(/type="password"/i);
    // Nombres de atributo insensibles a mayúsculas: el HTML los interpreta así.
    expect(html).toMatch(/autocomplete="username"/i);
    expect(html).toMatch(/autocomplete="current-password"/i);
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).toMatch(/pattern="\[0-9\]\{6\}"/);
  });

  it('el inicio de sesión y el enlace llevan las insignias de la barra superior, sin la marca: no muestran datos', () => {
    for (const screen of ['acceso', 'enlace']) {
      const text = textOf(topBarOf(read([screen, 'index.html'])));
      for (const mark of ['Modo:', 'Salud:']) {
        expect(text, `${screen} ${mark}`).toContain(mark);
      }
      expect(text, screen).not.toContain('Datos ficticios');
    }
  });

  it('cada página: el modo desactivado y la salud, que se lee en el navegador', () => {
    for (const item of NAV_ITEMS) {
      const text = textOf(topBarOf(read(pageOf(item.href))));
      expect(text, item.href).toContain('Modo: Desactivado');
      expect(text, item.href).toContain('Salud: Leyendo…');
      // Ni el modo ni la salud ficticios del prototipo.
      expect(text, item.href).not.toMatch(/Modo: Shadow|Salud: Degradado/);
    }
  });

  it('la marca de datos ficticios va solo en las secciones que siguen con datos ficticios', () => {
    const real = NAV_ITEMS.filter((item) => item.realInApi === true).map((item) => item.href);
    expect(real).toEqual(['/', '/mercados/', '/datos/', '/auditoria/']);
    for (const item of NAV_ITEMS) {
      const text = textOf(topBarOf(read(pageOf(item.href))));
      if (item.realInApi === true) {
        expect(text, item.href).not.toContain('Datos ficticios');
      } else {
        expect(text, item.href).toContain('Datos ficticios');
      }
    }
  });

  it('el Observatorio es la variante real: pide la salud a la API, sin los datos ficticios', () => {
    const text = textOf(read(['index.html']));
    expect(text).toContain('Captura de Deriv');
    expect(text).toContain('Cargando la salud de los datos');
    expect(text).not.toMatch(/Ruptura de rango|Vantage|Deriv MT5|Pérdida neta/);
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/datos/salud'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });

  it('Mercados es la variante real: pide el gráfico y el catálogo a la API, sin los datos ficticios', () => {
    const text = textOf(read(['mercados', 'index.html']));
    expect(text).toContain('Cargando el gráfico de R_100');
    expect(text).toContain('Cargando el catálogo de Deriv');
    expect(text).not.toMatch(/ficticio|\(ejemplo\)|Vantage|Deriv MT5/u);
    for (const route of ['/api/v1/datos/grafico', '/api/v1/datos/catalogo']) {
      const calling = files(OUT_API, '.js').filter((script) =>
        readFileSync(script, 'utf8').includes(route),
      );
      expect(calling.length, route).toBeGreaterThan(0);
    }
  });

  it('la pantalla de enlace es un marco sin formulario: el QR y el formulario llegan al leer el token', () => {
    const html = read(['enlace', 'index.html']);
    expect(textOf(html)).toContain('Leyendo el enlace');
    expect(html).not.toMatch(/<form\b/i);
  });

  it('ninguna página carga direcciones absolutas ni recursos de terceros', () => {
    const pages = files(OUT_API, '.html');
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const external = [
        ...readFileSync(page, 'utf8').matchAll(/(?:src|href|action)="(https?:\/\/[^"]+)"/g),
      ].map((match) => match[1]);
      expect(external, page).toEqual([]);
    }
  });

  it('sus hojas de estilo no cargan recursos de terceros', () => {
    const sheets = files(OUT_API, '.css');
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      const css = readFileSync(sheet, 'utf8');
      expect(css, sheet).not.toMatch(/url\(\s*['"]?https?:/i);
      expect(css, sheet).not.toMatch(/@import\s+(url\()?\s*['"]?https?:/i);
    }
  });

  it('su menú de la sesión lee y guarda el tema de la cuenta (ADR-0019 §7)', () => {
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/preferencias'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });

  it('su JavaScript sí llama a la API, bajo /api/v1/', () => {
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });

  it('la sección Datos es la variante real: pide los datasets a la API, no las tablas ficticias', () => {
    const text = textOf(read(['datos', 'index.html']));
    expect(text).toContain('Datasets publicados');
    expect(text).toContain('Cargando los datasets publicados');
    // El título de la tabla ficticia del escritorio no aparece en la variante real.
    expect(text).not.toContain('Incidencias de calidad');
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/datos/datasets'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });

  it('la sección Auditoría es la variante real: pide los eventos a la API, no la tabla ficticia', () => {
    const text = textOf(read(['auditoria', 'index.html']));
    expect(text).toContain('Eventos de la cuenta');
    expect(text).toContain('Eventos de datos');
    expect(text).toContain('Cargando los eventos de datos');
    // El título de la tabla ficticia del escritorio no aparece en la variante real.
    expect(text).not.toContain('Datos y estrategias');
    for (const path of ['/api/v1/auditoria', '/api/v1/datos/eventos']) {
      const calling = files(OUT_API, '.js').filter((script) =>
        readFileSync(script, 'utf8').includes(path),
      );
      expect(calling.length, path).toBeGreaterThan(0);
    }
  });
});
