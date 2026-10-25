import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INTEGRATIONS,
  MODES,
  PAGES,
  PLATFORMS,
  ROADMAP,
  WRITTEN_FOR_NEXT_DELIVERY,
} from '../src/content';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

/**
 * Fases del roadmap canónico, con la nota de su título: «## Fase 1B — Título (nota)» y
 * «## Línea visual V1 (nota)». La nota «completada» marca una fase terminada.
 */
function roadmapPhases(): { id: string; title: string; note: string | undefined }[] {
  const phases: { id: string; title: string; note: string | undefined }[] = [];
  for (const line of read('docs/producto/roadmap.md').split('\n')) {
    const phase = /^## Fase (\w+) — (.+?)(?: \((.*)\))?$/.exec(line);
    if (phase !== null) {
      phases.push({ id: phase[1] ?? '', title: phase[2] ?? '', note: phase[3] });
      continue;
    }
    const line_v = /^## (Línea visual (V\d+))(?: \((.*)\))?$/.exec(line);
    if (line_v !== null) {
      phases.push({ id: line_v[2] ?? '', title: line_v[1] ?? '', note: line_v[3] });
    }
  }
  return phases;
}

/** Bloque inicial entre `---` de un documento, donde están sus campos de estado. */
const frontMatter = (text: string) => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';

describe('contenido del sitio frente a las fuentes canónicas (V1-SITE-001)', () => {
  it('las fases coinciden con docs/producto/roadmap.md, en el mismo orden', () => {
    expect(ROADMAP.map(({ id, title }) => ({ id, title }))).toEqual(
      roadmapPhases().map(({ id, title }) => ({ id, title })),
    );
  });

  it('el estado de las fases coincide con el roadmap y PROJECT_STATUS.md', () => {
    const status = frontMatter(read('PROJECT_STATUS.md'));
    const current = /^current_phase: "Fase (\w+) — /m.exec(status)?.[1];
    const active = /^phase_status: "(\w+)"/m.exec(status)?.[1];
    expect(active).toBe('active');
    expect(ROADMAP.filter((p) => p.state === 'en curso').map((p) => p.id)).toEqual([current]);

    // Hechas en el sitio = completadas en el roadmap; entre ellas, la Fase 0 y la línea visual V1.
    const completed = roadmapPhases()
      .filter((p) => p.note === 'completada')
      .map((p) => p.id);
    expect(completed).toEqual(expect.arrayContaining(['0', 'V1']));
    expect(ROADMAP.filter((p) => p.state === 'hecha').map((p) => p.id)).toEqual(completed);

    // La línea V1 se cerró: su plan está `done` y ya no corre en paralelo (plan V1 §7).
    expect(frontMatter(read('docs/plan/linea-visual-v1.md'))).toMatch(/^status: "done"$/m);
    expect(status).not.toContain('linea-visual-v1.md');

    const current_index = ROADMAP.findIndex((p) => p.id === current);
    for (const phase of ROADMAP.slice(current_index + 1)) {
      expect(phase.state, phase.id).toBe('prevista');
    }
  });

  it('los modos son los del contrato y en su fase del catálogo de funciones', () => {
    expect(MODES.map((m) => m.mode)).toEqual(['disabled', 'shadow', 'demo', 'real']);
    const catalog = read('docs/producto/funciones-y-disponibilidad.md');
    for (const [mode, phase] of [
      ['shadow', '2'],
      ['demo', '4'],
      ['real', '6'],
    ] as const) {
      expect(catalog).toMatch(new RegExp(`\\| \`${mode}\` \\|[^\\n]*\\| Fase ${phase} \\|`));
      expect(MODES.find((m) => m.mode === mode)?.phase).toBe(`Fase ${phase}`);
    }
  });

  it('las integraciones son las de ADR-0007 y el roadmap, con sus fases', () => {
    const adr = read('docs/arquitectura/adr/0007-varias-fuentes-y-metatrader-5.md');
    const roadmap = read('docs/producto/roadmap.md');
    expect(INTEGRATIONS.map((i) => i.name)).toEqual([
      'Deriv',
      'MetaTrader 5 · Deriv MT5',
      'MetaTrader 5 · Vantage',
    ]);
    expect(adr).toContain('con dos brókeres: Deriv MT5 y Vantage');
    expect(roadmap).toContain('## Fase 1B — Datos de MetaTrader 5');
    expect(roadmap).toContain('ejecución demo en MT5 por el puente');
    expect(INTEGRATIONS[0]?.phase).toBe('Datos en Fase 1; demo en Fase 4');
    for (const integration of INTEGRATIONS.slice(1)) {
      expect(integration.phase).toBe('Datos en Fase 1B; demo en Fase 4');
    }
  });

  it('las plataformas llegan en la fase del catálogo de funciones', () => {
    const catalog = read('docs/producto/funciones-y-disponibilidad.md');
    const phaseOf = (row: string) =>
      new RegExp(`\\| \\*\\*${row}\\*\\*[^|]*\\|[^|]*\\| Fase (\\w+)`).exec(catalog)?.[1];
    expect(phaseOf('Web')).toBe('2');
    expect(phaseOf('Móvil')).toBe('3');
    expect(phaseOf('Escritorio')).toBe('7');
    expect(PLATFORMS.map((p) => /^Fase (\w+)/.exec(p.phase)?.[1])).toEqual(['2', '3', '7']);
    expect(catalog).toMatch(/\| \*Kill switch\* \|[^\n]*\| 4 \|/);
    for (const platform of PLATFORMS) {
      if (/interruptor|kill switch/i.test(platform.role)) {
        expect(Number(/^Fase (\d+)/.exec(platform.phase)?.[1])).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('el texto sobre lo que existe hoy corresponde a la entrega actual', () => {
    const status = read('PROJECT_STATUS.md');
    expect(/^next_delivery: "([^"]+)"/m.exec(status)?.[1]).toBe(WRITTEN_FOR_NEXT_DELIVERY);
  });

  it('cada página tiene una ruta única con barra final', () => {
    expect(new Set(PAGES.map((p) => p.href)).size).toBe(PAGES.length);
    for (const page of PAGES) {
      expect(page.href).toMatch(/^\/([a-z-]+\/)?$/);
    }
  });
});
