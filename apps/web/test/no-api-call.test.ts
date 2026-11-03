/**
 * Evidencia de F2-UI-001 (ADR-0019 §9): la variante del escritorio (`out`) no llama a la API. Es el
 * prototipo local con datos ficticios (ADR-0010), así que su JavaScript —los fragmentos y los
 * scripts en línea— no menciona ninguna ruta `/api/`, y no incluye las pantallas de la API.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OUT = fileURLToPath(new URL('../out/', import.meta.url));

function files(dir: string, extension: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, extension);
    return name.endsWith(extension) ? [path] : [];
  });
}

describe('la variante del escritorio no llama a la API (F2-UI-001)', () => {
  it('ningún fragmento de JavaScript menciona una ruta /api/', () => {
    const scripts = files(OUT, '.js');
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(readFileSync(script, 'utf8'), script).not.toMatch(/\/api\//);
    }
  });

  it('ningún script en línea de su HTML menciona una ruta /api/', () => {
    const pages = files(OUT, '.html');
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const inline = [
        ...readFileSync(page, 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
      ].map((match) => match[1] ?? '');
      for (const code of inline) {
        expect(code, page).not.toMatch(/\/api\//);
      }
    }
  });

  it('no incluye las pantallas de la API: acceso y enlace son solo de out-api', () => {
    expect(existsSync(join(OUT, 'acceso'))).toBe(false);
    expect(existsSync(join(OUT, 'enlace'))).toBe(false);
  });
});
