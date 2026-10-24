import { describe, expect, it } from 'vitest';
import {
  BACKTEST_CONTEXT,
  equitySeries,
  INSTRUMENTS,
  priceSeries,
  PRICE_GAPS,
  SHADOW_CONTEXT,
  SIGNALS,
} from '../src/fixtures';
import { formatUtc } from '../src/format';

describe('datos ficticios del prototipo (V1-UI-001)', () => {
  it('toda señal trae estrategia, versión, modo, vencimiento posterior a la emisión y evidencia', () => {
    for (const signal of SIGNALS) {
      expect(signal.strategy.length).toBeGreaterThan(0);
      expect(signal.version).toMatch(/^v\d+$/);
      expect(['shadow', 'demo', 'real', 'disabled']).toContain(signal.mode);
      expect(Date.parse(signal.expiresUtc)).toBeGreaterThan(Date.parse(signal.issuedUtc));
      expect(signal.evidenceHref).toMatch(/^\/[a-z]+\/$/);
    }
  });

  it('el prototipo no muestra señales en demo ni en real antes de su fase', () => {
    expect(SIGNALS.every((signal) => signal.mode === 'shadow')).toBe(true);
  });

  it('las métricas de desempeño traen todo su contexto, sin campos vacíos', () => {
    for (const context of [BACKTEST_CONTEXT, SHADOW_CONTEXT]) {
      for (const [field, value] of Object.entries(context)) {
        expect(String(value).trim().length, field).toBeGreaterThan(0);
      }
    }
  });

  it('la curva de capital coincide con su contexto: termina en −0,4 y cae 3,6 como máximo', () => {
    const values = equitySeries();
    let peak = Number.NEGATIVE_INFINITY;
    let drawdown = 0;
    for (const v of values) {
      peak = Math.max(peak, v);
      drawdown = Math.max(drawdown, peak - v);
    }
    expect(values.at(-1)).toBe(-0.4);
    expect(drawdown.toFixed(1)).toBe('3.6');
    expect(BACKTEST_CONTEXT.drawdown).toBe('−3,6 %');
  });

  it('los huecos de la serie de precios son null y están declarados', () => {
    const values = priceSeries();
    for (const gap of PRICE_GAPS) {
      for (let i = gap.start; i < gap.end; i += 1) {
        expect(values[i]).toBeNull();
      }
      expect(values[gap.start - 1]).not.toBeNull();
      expect(values[gap.end]).not.toBeNull();
    }
    expect(priceSeries()).toEqual(values);
  });

  it('todo instrumento dice su fuente, cadencia, frescura y calidad', () => {
    for (const instrument of INSTRUMENTS) {
      expect(instrument.source.length).toBeGreaterThan(0);
      expect(instrument.cadence.length).toBeGreaterThan(0);
      expect(instrument.freshness.length).toBeGreaterThan(0);
      expect(instrument.quality.label.length).toBeGreaterThan(0);
    }
  });

  it('las fechas se muestran en UTC sin depender del equipo', () => {
    expect(formatUtc('2026-10-20T14:32:05.000Z')).toBe('20 oct 2026, 14:32:05 UTC');
  });
});
