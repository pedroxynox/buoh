/**
 * Evidencia de V1-MOBILE-001: cada pestaña se renderiza (con React Native for Web) y se comprueba su
 * contenido contra el concepto de interfaz, el catálogo de funciones y las reglas del prototipo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXECUTION_MODE_PRESENTATION, SERVICE_HEALTH_PRESENTATION } from '@buoh/design-system';
import {
  APPROVED_VALIDATION,
  GLOBAL_STATUS,
  INCIDENTS,
  SHADOW_CONTEXT,
  SIGNALS,
  STRATEGIES,
} from '@buoh/prototype-data';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  alertsInOrder,
  APPROVED_EVIDENCE,
  LATEST_SIGNALS,
  LOCKED_ON_MOBILE,
  ONLY_ON_WEB,
  SHADOW_EVIDENCE,
  TABS,
} from '../src/model';
import {
  AlertasScreen,
  EvidenciaScreen,
  InicioScreen,
  MasScreen,
  SenalesScreen,
} from '../src/screens';
import { BottomBar, TopBar } from '../src/shell';

// React Native declara su propio `URL`; se usan rutas de texto para no mezclar ambos tipos.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
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
  ['senales', <SenalesScreen key="s" onNavigate={() => undefined} />],
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
    const text = textOf(SCREENS[1][1]);
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

  it('la evidencia muestra el shadow de la estrategia activa y la validación de cada aprobada', () => {
    const active = STRATEGIES.filter((strategy) => strategy.lifecycle === 'active');
    expect(active.map((s) => `${s.name} ${s.version}`)).toEqual([SHADOW_EVIDENCE.context.version]);
    expect(SHADOW_EVIDENCE.context).toBe(SHADOW_CONTEXT);
    const approved = STRATEGIES.filter((strategy) => strategy.approvedForShadowUtc !== null);
    expect(APPROVED_EVIDENCE.map((item) => item.strategyId)).toEqual(approved.map((s) => s.id));
    for (const item of APPROVED_EVIDENCE) {
      expect(item.context.source).toBe('backtest');
      expect(item.context.version).toBe(item.version);
    }
    const text = textOf(<EvidenciaScreen />);
    expect((text.match(/Limitaciones:/g) ?? []).length).toBe(1 + APPROVED_VALIDATION.length);
    // Concepto §1.3: toda señal enlaza a su evidencia, también la de una estrategia en pausa.
    for (const signal of SIGNALS) {
      expect(text).toContain(`${signal.strategy} ${signal.version}`);
    }
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

  it('los únicos controles navegan: «Ver alertas» y «Ver evidencia» en cada señal', () => {
    const expected: Record<string, number> = {
      inicio: 1 + LATEST_SIGNALS.length,
      senales: SIGNALS.length,
      alertas: 0,
      evidencia: 0,
      mas: 0,
    };
    for (const [id, screen] of SCREENS) {
      const buttons = (htmlOf(screen).match(/role="button"/g) ?? []).length;
      expect(buttons, id).toBe(expected[id]);
    }
    expect(textOf(SCREENS[0][1])).toContain('Ver alertas');
    expect(textOf(SCREENS[1][1]).match(/Ver evidencia/g)?.length).toBe(SIGNALS.length);
  });

  it('el «kill switch» con candado es lo primero en «Más»', () => {
    const text = textOf(<MasScreen />);
    const first = LOCKED_ON_MOBILE[0];
    expect(first.title).toMatch(/kill switch/);
    expect(text.indexOf(first.title)).toBeGreaterThan(-1);
    expect(text.indexOf(first.title)).toBeLessThan(text.indexOf('Cada una con su propia salud'));
  });
});

describe('marco de la app (V1-MOBILE-001)', () => {
  it('la barra superior muestra siempre modo, salud y el aviso de datos ficticios', () => {
    const html = htmlOf(<TopBar />);
    const text = textOf(<TopBar />);
    expect(html).toContain('aria-label="Estado global"');
    expect(html).toContain(
      `aria-label="Modo: ${EXECUTION_MODE_PRESENTATION[GLOBAL_STATUS.mode].label}`,
    );
    expect(html).toContain(
      `aria-label="Salud: ${SERVICE_HEALTH_PRESENTATION[GLOBAL_STATUS.health].label}`,
    );
    expect(text).toContain('Datos ficticios');
    expect(html).not.toMatch(/role="button"/);
  });

  it('la barra de pestañas tiene sus roles y marca solo la pestaña actual', () => {
    for (const tab of TABS) {
      const html = htmlOf(<BottomBar current={tab.id} onSelect={() => undefined} />);
      expect(html).toMatch(
        /role="tablist"[^>]*aria-label="Secciones"|aria-label="Secciones"[^>]*role="tablist"/,
      );
      expect(html.match(/role="tab"/g)?.length).toBe(TABS.length);
      expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
      expect(html).toMatch(
        new RegExp(
          `aria-label="${tab.label}"[^>]*aria-selected="true"|aria-selected="true"[^>]*aria-label="${tab.label}"`,
        ),
      );
    }
  });
});

describe('versiones de React en el móvil', () => {
  // `turbo run test` depende de `build`, así que `out/` existe al llegar aquí.
  const OUT = join(HERE, '..', 'out', '_expo', 'static', 'js');

  it('cada paquete exportado lleva solo React 19.3.0, la versión exacta que pide React Native', () => {
    expect(
      existsSync(OUT),
      'falta out/: ejecuta antes `pnpm --filter @buoh/mobile run build`',
    ).toBe(true);
    const platforms = readdirSync(OUT);
    expect([...platforms].sort()).toEqual(['android', 'ios', 'web']);
    for (const platform of platforms) {
      for (const file of readdirSync(join(OUT, platform))) {
        const bundle = readFileSync(join(OUT, platform, file), 'latin1');
        expect(bundle, `${platform}/${file}`).toContain('19.3.0');
        expect(bundle, `${platform}/${file}`).not.toContain('19.3.1');
      }
    }
  });
});
