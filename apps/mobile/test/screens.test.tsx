/**
 * Evidencia de V1-MOBILE-001: cada pestaña se renderiza (con React Native for Web) y se comprueba su
 * contenido contra el concepto de interfaz, el catálogo de funciones y las reglas del prototipo.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTION_MODE_PRESENTATION, SERVICE_HEALTH_PRESENTATION } from '@buoh/design-system';
import { GLOBAL_STATUS, INCIDENTS, SIGNALS } from '@buoh/prototype-data';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alertsInOrder, LOCKED_ON_MOBILE, ONLY_ON_WEB, SHADOW_EVIDENCE, TABS } from '../src/model';
import {
  AlertasScreen,
  EvidenciaScreen,
  InicioScreen,
  MasScreen,
  SenalesScreen,
} from '../src/screens';

// React Native declara su propio `URL`; se usan rutas de texto para no mezclar ambos tipos.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function textOf(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function htmlOf(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

const SCREENS = [
  ['inicio', <InicioScreen key="i" onNavigate={() => undefined} />],
  ['senales', <SenalesScreen key="s" />],
  ['alertas', <AlertasScreen key="a" />],
  ['evidencia', <EvidenciaScreen key="e" />],
  ['mas', <MasScreen key="m" />],
] as const;

const FORBIDDEN = [
  /ganancia garantizada/i,
  /sin riesgo/i,
  /dinero fácil/i,
  /hazte rico/i,
  /señal segura/i,
  /última oportunidad/i,
];

describe('prototipo móvil (V1-MOBILE-001)', () => {
  it('tiene las cinco pestañas del concepto de interfaz, en orden', () => {
    expect(TABS.map((t) => t.label)).toEqual(['Inicio', 'Señales', 'Alertas', 'Evidencia', 'Más']);
    expect(read('docs/diseno/concepto-de-interfaz.md')).toContain(
      '**Móvil:** Observatorio, Señales, Alertas, Evidencia y *kill switch*',
    );
    expect(SCREENS.map(([id]) => id)).toEqual(TABS.map((t) => t.id));
  });

  it.each(SCREENS)('%s: sin campos de texto, contraseñas ni promesas', (_id, screen) => {
    const html = htmlOf(screen);
    expect(html).not.toMatch(/<(input|textarea|select|form)\b/i);
    for (const pattern of FORBIDDEN) {
      expect(textOf(screen)).not.toMatch(pattern);
    }
  });

  it.each(SCREENS)('%s: cada cifra de desempeño lleva su contexto completo', (_id, screen) => {
    const text = textOf(screen);
    const metrics = (text.match(/Limitaciones:/g) ?? []).length;
    for (const label of [
      'Origen',
      'Período',
      'Muestra',
      'Costes',
      'Pérdidas',
      'Drawdown máximo',
      'Versión',
    ]) {
      expect((text.match(new RegExp(label, 'g')) ?? []).length, label).toBeGreaterThanOrEqual(
        metrics,
      );
    }
    if (!text.includes('Limitaciones:')) {
      expect(text).not.toMatch(/[+−-]\d+,\d\s?%/);
    }
  });

  it('el inicio muestra modo y salud por separado, con texto', () => {
    const text = textOf(SCREENS[0][1]);
    expect(text).toContain(EXECUTION_MODE_PRESENTATION[GLOBAL_STATUS.mode].label);
    expect(text).toContain(SERVICE_HEALTH_PRESENTATION[GLOBAL_STATUS.health].label);
    expect(htmlOf(SCREENS[0][1])).toContain('aria-label="Modo: ');
    expect(htmlOf(SCREENS[0][1])).toContain('aria-label="Salud: ');
  });

  it('las señales muestran estrategia, versión, modo, vencimiento, calidad y que no son órdenes', () => {
    const text = textOf(<SenalesScreen />);
    for (const signal of SIGNALS) {
      expect(text).toContain(`${signal.strategy} ${signal.version}`);
    }
    expect(text.match(/Vence/g)?.length).toBe(SIGNALS.length);
    expect(text.match(/Una señal no es una orden\./g)?.length).toBe(SIGNALS.length);
    expect(text).toContain('Datos completos');
  });

  it('las alertas empiezan por las condiciones abiertas y las muestran todas', () => {
    const ordered = alertsInOrder();
    expect(ordered[0]?.status).toBe('abierta');
    expect(ordered).toHaveLength(INCIDENTS.length);
    expect(textOf(<AlertasScreen />).match(/Severidad|Error|Aviso/g)?.length).toBeGreaterThan(0);
  });

  it('la evidencia es la de la estrategia en shadow y la validación que la aprobó', () => {
    expect(SHADOW_EVIDENCE.validation?.version).toBe(SHADOW_EVIDENCE.context.version);
    expect(SHADOW_EVIDENCE.validationContext?.source).toBe('backtest');
    expect((textOf(<EvidenciaScreen />).match(/Limitaciones:/g) ?? []).length).toBe(2);
  });

  it('«Más» bloquea lo de Fase 4 y deja en la web lo que cambia riesgo, como el catálogo', () => {
    const text = textOf(<MasScreen />);
    for (const item of LOCKED_ON_MOBILE) {
      expect(text).toContain(`Disponible en Fase ${item.phase}`);
    }
    const catalog = read('docs/producto/funciones-y-disponibilidad.md');
    expect(catalog).toMatch(/\| Pedir el modo `real` \|[^\n]*\| 6 \| ● \| — \| ● \|/);
    expect(catalog).toMatch(/\| \*Kill switch\* \|[^\n]*\| 4 \| ● \| ● \| ● \|/);
    expect(ONLY_ON_WEB.some((item) => item.includes('modo real'))).toBe(true);
    expect(htmlOf(<MasScreen />)).not.toMatch(/role="button"/);
  });

  it('solo el inicio tiene un control, y solo navega', () => {
    for (const [id, screen] of SCREENS) {
      const buttons = (htmlOf(screen).match(/role="button"/g) ?? []).length;
      expect(buttons, id).toBe(id === 'inicio' ? 1 : 0);
    }
    expect(textOf(SCREENS[0][1])).toContain('Ver alertas');
  });
});
