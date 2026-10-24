/**
 * Comprueba el sitio exportado (`out/`, generado por `build`, que turbo ejecuta antes de `test`).
 * Evidencia de V1-UI-001: cada pantalla muestra modo, salud y la marca de datos ficticios, y no
 * contiene formularios, contraseñas, recursos de terceros ni promesas prohibidas por la guía de marca.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../src/navigation';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

function htmlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return htmlFiles(path);
    }
    return name.endsWith('.html') ? [path] : [];
  });
}

function textOf(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

const FORBIDDEN = [
  /ganancia garantizada/i,
  /sin riesgo/i,
  /dinero fácil/i,
  /hazte rico/i,
  /señal segura/i,
  /última oportunidad/i,
];

describe('prototipo exportado (V1-UI-001)', () => {
  it('la exportación existe', () => {
    expect(existsSync(join(OUT, 'index.html'))).toBe(true);
  });

  // Incluye la página 404: también va dentro del marco con modo, salud y aviso.
  const pages = existsSync(OUT) ? htmlFiles(OUT) : [];

  it('exporta una página por cada sección de la navegación', () => {
    for (const item of NAV_ITEMS) {
      const file = item.href === '/' ? 'index.html' : join(item.href.slice(1), 'index.html');
      expect(existsSync(join(OUT, file)), item.href).toBe(true);
    }
  });

  it.each(pages.map((p) => [p.replace(OUT, '')]))(
    '%s muestra modo, salud y datos ficticios',
    (page) => {
      const text = textOf(readFileSync(join(OUT, page), 'utf8'));
      expect(text).toContain('Modo:');
      expect(text).toContain('Salud:');
      expect(text).toContain('Datos ficticios');
    },
  );

  it.each(pages.map((p) => [p.replace(OUT, '')]))(
    '%s no tiene formularios, contraseñas ni promesas',
    (page) => {
      const html = readFileSync(join(OUT, page), 'utf8');
      expect(html).not.toMatch(/<form\b/i);
      expect(html).not.toMatch(/type="password"/i);
      expect(html).not.toMatch(/<input\b/i);
      for (const pattern of FORBIDDEN) {
        expect(textOf(html)).not.toMatch(pattern);
      }
      for (const match of html.matchAll(/<button\b[^>]*>/g)) {
        const tag = match[0];
        const allowed = tag.includes('disabled') || tag.includes('type="button"');
        expect(allowed, tag).toBe(true);
      }
    },
  );

  it.each(pages.map((p) => [p.replace(OUT, '')]))('%s no carga recursos de terceros', (page) => {
    const html = readFileSync(join(OUT, page), 'utf8');
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(external).toEqual([]);
  });

  it('las secciones de Fase 4 o posteriores solo tienen controles desactivados', () => {
    for (const item of NAV_ITEMS.filter((i) => i.lockedUntil !== undefined)) {
      const html = readFileSync(join(OUT, item.href.slice(1), 'index.html'), 'utf8');
      expect(html).toContain(`Disponible en Fase ${item.lockedUntil ?? ''}`);
      for (const match of html.matchAll(/<button\b[^>]*>/g)) {
        expect(match[0], item.href).toMatch(/disabled/);
      }
    }
  });
});
