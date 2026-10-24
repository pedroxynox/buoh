import { executionModeSchema, serviceHealthSchema } from '@buoh/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EXECUTION_MODE_PRESENTATION, SERVICE_HEALTH_PRESENTATION } from '../src/index.js';
import {
  BuohLogo,
  BuohMark,
  HealthBadge,
  MetricWithContext,
  ModeBadge,
  PhaseLock,
} from '../src/react/index.js';

describe('componentes React', () => {
  it('la insignia de modo nombra el eje y el modo en texto', () => {
    for (const mode of executionModeSchema.options) {
      const html = renderToStaticMarkup(<ModeBadge mode={mode} showDescription />);
      expect(html).toContain('Modo: ');
      expect(html).toContain(EXECUTION_MODE_PRESENTATION[mode].label);
      expect(html).toContain(EXECUTION_MODE_PRESENTATION[mode].description);
      expect(html).toContain('<svg');
    }
  });

  it('la insignia de salud nombra el eje y el estado en texto', () => {
    for (const health of serviceHealthSchema.options) {
      const html = renderToStaticMarkup(<HealthBadge health={health} />);
      expect(html).toContain('Salud: ');
      expect(html).toContain(SERVICE_HEALTH_PRESENTATION[health].label);
    }
  });

  it('una métrica muestra todo su contexto obligatorio', () => {
    const html = renderToStaticMarkup(
      <MetricWithContext
        label="Resultado neto"
        value="−1,8 %"
        context={{
          mode: 'shadow',
          period: 'P',
          sample: 'S',
          costs: 'C',
          losses: 'L',
          drawdown: 'D',
          version: 'V',
          limitations: 'X',
        }}
      />,
    );
    for (const text of [
      'Modo',
      'Período',
      'Muestra',
      'Costes',
      'Pérdidas',
      'Drawdown',
      'Versión',
      'Limitaciones',
    ]) {
      expect(html).toContain(text);
    }
  });

  it('el candado de fase no contiene controles', () => {
    const html = renderToStaticMarkup(<PhaseLock phase="4" title="Ejecución demo" />);
    expect(html).toContain('Disponible en Fase 4');
    expect(html).not.toMatch(/<(button|a|input|select)\b/);
  });

  it('el símbolo es decorativo dentro del logotipo y accesible solo', () => {
    expect(renderToStaticMarkup(<BuohLogo />)).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(<BuohMark />)).toContain('aria-label="buoh"');
  });
});
