/**
 * El Observatorio y la insignia de salud de la web servida por la API (`F2-UI-001`; concepto de
 * interfaz §10), dibujados con `renderToStaticMarkup` desde la vista de la salud: la causa, también en
 * `recovering` sin condiciones (pendiente 2 de F1.2), el modo aparte de la salud, los metadatos de
 * toda vista de datos, el último dataset, los estados de pantalla y ningún dato ficticio.
 */
import type { DataHealth, HealthReport } from '@buoh/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ObservatorioView } from '../src/components/ObservatorioReal';
import { SaludBadgeView } from '../src/components/salud/SaludBadge';
import { healthView, STALE_AFTER_MS, type DataHealthState } from '../src/components/salud/salud';

const OBSERVED = '2026-11-04T21:26:06.925Z';
const OBSERVED_MS = Date.parse(OBSERVED);

function report(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    schema_version: '1.0.0',
    source: 'deriv_options',
    execution_mode: 'disabled',
    service_health: 'healthy',
    connection_state: 'connected',
    backlog_count: 0,
    backlog_bytes: 0,
    last_observation_id: '01937e3a-5b6c-7d8e-9f01-23456789abcd',
    last_received_at_utc: '2026-11-04T21:26:05.000Z',
    last_event_time_utc: '2026-11-04T21:26:04.000Z',
    last_published_dataset_id: null,
    open_condition_types: [],
    ...overrides,
  };
}

function ready(value: HealthReport, checkedAtMs = OBSERVED_MS + 2 * 60_000): DataHealthState {
  const health: DataHealth = {
    log: 2,
    observation: { status: 'completed', observed_at_utc: OBSERVED, report: value, alerts: [] },
  };
  return { kind: 'ready', health, receivedAtMs: checkedAtMs, checkedAtMs, refreshFailure: null };
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

const observatorio = (state: DataHealthState) =>
  renderToStaticMarkup(<ObservatorioView view={healthView(state)} />);

describe('Observatorio con la salud real (F2-UI-001)', () => {
  it('en recovering sin condiciones muestra su causa: la continuidad pendiente (pendiente 2 de F1.2)', () => {
    const text = textOf(observatorio(ready(report({ service_health: 'recovering' }))));
    expect(text).toContain('Recuperando');
    expect(text).toContain('Continuidad pendiente');
    expect(text).toContain('Sin condiciones abiertas');
  });

  it('dice símbolo, fuente, zona horaria, intervalo, frescura y calidad', () => {
    const text = textOf(observatorio(ready(report())));
    for (const fact of [
      'Símbolo R_100',
      'Fuente Deriv · WebSocket público',
      'Zona horaria UTC',
      'Intervalo Una observación cada 5 minutos',
      'Frescura 4 nov 2026, 21:26:06 UTC, hace 2 min',
      'Calidad Sin condiciones abiertas',
      'Log activo Log 2',
      'Conexión Conectada',
      'Último tick 4 nov 2026, 21:26:04 UTC',
      'Cola sin guardar 0 eventos · 0 bytes',
    ]) {
      expect(text, fact).toContain(fact);
    }
  });

  it('el modo va aparte de la salud: desactivado, porque todavía no existe el motor de señales', () => {
    const html = observatorio(
      ready(report({ service_health: 'degraded', open_condition_types: ['event_gap_unresolved'] })),
    );
    const text = textOf(html);
    expect(text).toContain('Modo: Desactivado');
    expect(text).toContain('Salud: Degradado');
    expect(text).toContain('Hueco sin resolver');
  });

  it('el último dataset: vacío hasta que se publique el primero, y su identificador después', () => {
    expect(textOf(observatorio(ready(report())))).toContain('Todavía no hay ninguno publicado');
    const id = `sha256:${'b'.repeat(64)}`;
    expect(observatorio(ready(report({ last_published_dataset_id: id })))).toContain(id);
  });

  it('las partes que llegan después tienen su estado vacío, sin datos ficticios', () => {
    const text = textOf(observatorio(ready(report())));
    expect(text).toContain('Todavía no hay ninguna estrategia en shadow');
    expect(text).toContain('Todavía no hay señales');
    expect(text).toContain('Disponible en Fase 4');
    expect(text).not.toContain('Datos ficticios');
    // Ninguna cifra ni nombre de los datos ficticios del prototipo (@buoh/prototype-data).
    expect(text).not.toMatch(/Ruptura de rango|Vantage|Deriv MT5|Pérdida neta/);
  });

  it('cargando: un esqueleto quieto y un texto para el lector de pantalla', () => {
    const html = observatorio({ kind: 'loading' });
    expect(html).toContain('w-skeleton');
    expect(textOf(html)).toContain('Cargando la salud de los datos');
  });

  it('sin sesión: qué falló y un enlace para iniciarla', () => {
    const html = observatorio({ kind: 'failed', failure: { code: 'unauthenticated' } });
    expect(textOf(html)).toContain('No se pudo leer la salud');
    expect(html).toMatch(/<a [^>]*href="\/acceso"[^>]*>Iniciar sesión<\/a>/);
  });

  it('si una actualización falla, lo dice y conserva la última lectura buena', () => {
    const state = ready(report());
    const html = observatorio({
      ...state,
      checkedAtMs: OBSERVED_MS + 3 * 60_000,
      refreshFailure: { code: 'network' },
    } as DataHealthState);
    const text = textOf(html);
    expect(text).toContain('No se pudo actualizar');
    expect(text).toContain('21:28:06 UTC');
    expect(text).toContain('Saludable');
  });

  it('una observación antigua lleva su marca y su causa', () => {
    const text = textOf(observatorio(ready(report(), OBSERVED_MS + STALE_AFTER_MS + 60_000)));
    expect(text).toContain('Observación antigua');
    expect(text).toContain('hace 16 min');
  });
});

describe('insignia de salud de la barra superior (concepto de interfaz §4)', () => {
  const badge = (state: DataHealthState) =>
    textOf(renderToStaticMarkup(<SaludBadgeView view={healthView(state)} />));

  it('con un informe, la insignia de su estado', () => {
    expect(badge(ready(report({ service_health: 'recovering' })))).toContain('Salud: Recuperando');
  });

  it('sin informe, una insignia neutra que dice por qué, nunca uno de los seis estados', () => {
    const text = badge({ kind: 'failed', failure: { code: 'unauthenticated' } });
    expect(text).toContain('Salud: Sin sesión');
    for (const state of [
      'Iniciando',
      'Saludable',
      'Degradado',
      'Recuperando',
      'En pausa',
      'Fallido',
    ]) {
      expect(text).not.toContain(state);
    }
    expect(badge({ kind: 'loading' })).toContain('Salud: Leyendo…');
  });

  it('una observación antigua suma su marca', () => {
    expect(badge(ready(report(), OBSERVED_MS + STALE_AFTER_MS + 1))).toContain('Antigua');
    expect(badge(ready(report()))).not.toContain('Antigua');
  });
});
