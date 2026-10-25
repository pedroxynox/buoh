import { executionModeSchema, serviceHealthSchema } from '@buoh/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_MODE_PRESENTATION,
  LOGO_SYMBOL,
  LOGO_WORDMARK,
  SERVICE_HEALTH_PRESENTATION,
} from '../src/index.js';
import {
  BuohLogo,
  BuohMark,
  Card,
  FictitiousDataNotice,
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

  it('una métrica muestra cada valor de su contexto obligatorio', () => {
    const context = {
      source: 'shadow',
      period: 'periodo-01',
      sample: 'muestra-02',
      costs: 'costes-03',
      losses: 'perdidas-04',
      drawdown: 'drawdown-05',
      version: 'version-06',
      limitations: 'limites-07',
    } as const;
    const html = renderToStaticMarkup(
      <MetricWithContext label="Resultado neto" value="−1,8 %" context={context} />,
    );
    for (const value of Object.values(context).filter((v) => v !== 'shadow')) {
      expect(html).toContain(value);
    }
    expect(html).toContain(EXECUTION_MODE_PRESENTATION.shadow.label);
    for (const label of [
      'Origen',
      'Período',
      'Muestra',
      'Costes',
      'Pérdidas',
      'Drawdown',
      'Versión',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('una métrica de backtest lleva su propia insignia con icono', () => {
    const html = renderToStaticMarkup(
      <MetricWithContext
        label="x"
        value="y"
        context={{
          source: 'backtest',
          period: 'p',
          sample: 's',
          costs: 'c',
          losses: 'l',
          drawdown: 'd',
          version: 'v',
          limitations: 'x',
        }}
      />,
    );
    expect(html).toContain('Backtest');
    expect(html).toContain('<svg');
  });

  it('el candado de fase no contiene controles, ni con descripción', () => {
    for (const html of [
      renderToStaticMarkup(<PhaseLock phase="4" title="Ejecución demo" />),
      renderToStaticMarkup(
        <PhaseLock phase="4" title="Ejecución demo" description="Órdenes en cuenta de práctica." />,
      ),
    ]) {
      expect(html).toContain('Disponible en Fase 4');
      expect(html).not.toMatch(/<(button|a|input|select|textarea)\b/);
    }
  });

  it('la tarjeta usa el nivel de título pedido', () => {
    expect(renderToStaticMarkup(<Card title="T">x</Card>)).toContain('<h3');
    expect(
      renderToStaticMarkup(
        <Card title="T" headingLevel={2}>
          x
        </Card>,
      ),
    ).toContain('<h2');
  });

  it('el aviso de datos ficticios no usa un tono de estado', () => {
    const html = renderToStaticMarkup(<FictitiousDataNotice />);
    expect(html).toContain('Datos ficticios');
    expect(html).not.toContain('data-tone');
  });

  it('el logotipo es una sola imagen accesible con el símbolo y la palabra vectorizada', () => {
    const logo = renderToStaticMarkup(<BuohLogo />);
    expect(logo).toContain('role="img"');
    expect(logo).toContain('aria-label="buoh"');
    expect(logo).toContain(LOGO_WORDMARK.d);
    expect(logo).toContain(LOGO_SYMBOL.primary);
    expect(logo).not.toMatch(/<text\b/);
    expect(renderToStaticMarkup(<BuohMark />)).toContain('aria-label="buoh"');
    expect(renderToStaticMarkup(<BuohMark title={null} />)).toContain('aria-hidden="true"');
  });

  it('el símbolo conserva la proporción del original y su versión de una tinta', () => {
    const html = renderToStaticMarkup(<BuohMark size={100} />);
    const width = Number(/width="([\d.]+)"/.exec(html)?.[1]);
    expect(width / 100).toBeCloseTo(LOGO_SYMBOL.width / LOGO_SYMBOL.height, 2);
    const mono = renderToStaticMarkup(<BuohMark variant="mono" />);
    expect(mono).toContain(LOGO_SYMBOL.mono);
    expect(mono).toContain('fill="currentColor"');
    expect(mono).not.toContain('var(--b-brand');
  });
});
