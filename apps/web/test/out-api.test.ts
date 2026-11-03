/**
 * Evidencia de la variante servida por la API (`out-api`, ADR-0019 §9 y §14): trae las pantallas de
 * inicio de sesión y de enlace de alta, con los atributos que esperan los gestores de contraseñas, y
 * conserva las insignias de modo y salud y la marca de datos ficticios de la barra superior. Como el
 * resto del prototipo, no tiene direcciones absolutas ni recursos de terceros.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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

  it('el inicio de sesión conserva las insignias de la barra superior y la marca de datos ficticios', () => {
    const text = textOf(read(['acceso', 'index.html']));
    for (const mark of ['Modo:', 'Salud:', 'Datos ficticios']) {
      expect(text, mark).toContain(mark);
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

  it('su JavaScript sí llama a la API, bajo /api/v1/', () => {
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });

  it('la sección Auditoría es la variante real: pide los eventos a la API, no la tabla ficticia', () => {
    const text = textOf(read(['auditoria', 'index.html']));
    expect(text).toContain('Eventos de la cuenta');
    // El título de la tabla ficticia del escritorio no aparece en la variante real.
    expect(text).not.toContain('Datos y estrategias');
    const calling = files(OUT_API, '.js').filter((script) =>
      readFileSync(script, 'utf8').includes('/api/v1/auditoria'),
    );
    expect(calling.length).toBeGreaterThan(0);
  });
});
