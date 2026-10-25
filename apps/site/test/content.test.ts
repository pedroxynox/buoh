import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { INTEGRATIONS, MODES, PAGES, ROADMAP } from '../src/content';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

/** Fases del roadmap canónico: «## Fase 1B — Título (nota)» y «## Línea visual V1 (nota)». */
function roadmapPhases(): { id: string; title: string }[] {
  const phases: { id: string; title: string }[] = [];
  for (const line of read('docs/producto/roadmap.md').split('\n')) {
    const phase = /^## Fase (\w+) — (.+?)(?: \(.*\))?$/.exec(line);
    if (phase !== null) {
      phases.push({ id: phase[1] ?? '', title: phase[2] ?? '' });
      continue;
    }
    const line_v = /^## (Línea visual (V\d+))(?: \(.*\))?$/.exec(line);
    if (line_v !== null) {
      phases.push({ id: line_v[2] ?? '', title: line_v[1] ?? '' });
    }
  }
  return phases;
}

describe('contenido del sitio frente a las fuentes canónicas (V1-SITE-001)', () => {
  it('las fases coinciden con docs/producto/roadmap.md, en el mismo orden', () => {
    expect(ROADMAP.map(({ id, title }) => ({ id, title }))).toEqual(roadmapPhases());
  });

  it('el estado de las fases coincide con el roadmap y PROJECT_STATUS.md', () => {
    const status = read('PROJECT_STATUS.md');
    const current = /^current_phase: "Fase (\w+) — /m.exec(status)?.[1];
    const active = /^phase_status: "(\w+)"/m.exec(status)?.[1];
    expect(active).toBe('active');
    expect(ROADMAP.find((p) => p.id === current)?.state).toBe('en curso');
    expect(ROADMAP.find((p) => p.id === '0')?.state).toBe('hecha');
    expect(read('docs/producto/roadmap.md')).toContain('## Fase 0 — Fundación v2 (completada)');
    expect(status).toContain('docs/plan/linea-visual-v1.md');
    expect(ROADMAP.find((p) => p.id === 'V1')?.state).toBe('en curso');
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

  it('las integraciones son las de ADR-0007 y sus fases', () => {
    expect(INTEGRATIONS.map((i) => i.name)).toEqual([
      'Deriv',
      'MetaTrader 5 · Deriv MT5',
      'MetaTrader 5 · Vantage',
    ]);
    for (const integration of INTEGRATIONS.slice(1)) {
      expect(integration.phase).toContain('Fase 1B');
    }
  });

  it('cada página tiene una ruta única con barra final', () => {
    expect(new Set(PAGES.map((p) => p.href)).size).toBe(PAGES.length);
    for (const page of PAGES) {
      expect(page.href).toMatch(/^\/([a-z-]+\/)?$/);
    }
  });
});
